import { and, eq, gt, isNull } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { outbox, outboxRow } from "../../shared/outbox/schema";
import type { Provider } from "../domain/idTokenClaims";
import {
  loginCodes,
  oauthTransactions,
  refreshTokens,
  sessions,
  userIdentities,
  users,
} from "./schema";

// identity のD1アクセス。条件つきの消費は単独で実行し、結果を見てから残りをバッチで書く

export type Db = DrizzleD1Database;

export function db(d1: D1Database): Db {
  return drizzle(d1);
}

export async function saveOauthTransaction(db: Db, row: typeof oauthTransactions.$inferInsert) {
  await db.insert(oauthTransactions).values(row);
}

/** state を1回だけ取り出す（DELETE ... RETURNING）。期限切れは返さない */
export async function takeOauthTransaction(db: Db, stateHash: string, now: number) {
  const rows = await db
    .delete(oauthTransactions)
    .where(and(eq(oauthTransactions.stateHash, stateHash), gt(oauthTransactions.expiresAt, now)))
    .returning();
  return rows[0] ?? null;
}

export async function saveLoginCode(db: Db, row: typeof loginCodes.$inferInsert) {
  await db.insert(loginCodes).values(row);
}

export async function takeLoginCode(db: Db, codeHash: string, now: number) {
  const rows = await db
    .delete(loginCodes)
    .where(and(eq(loginCodes.codeHash, codeHash), gt(loginCodes.expiresAt, now)))
    .returning();
  return rows[0] ?? null;
}

/** (provider, sub) でユーザーを探し、なければ作る。確認済みのメールアドレスは未設定のときだけ保存する */
export async function findOrCreateUser(
  db: Db,
  provider: Provider,
  subject: string,
  email: string | null,
  now: number,
): Promise<string> {
  const existing = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
    .get();
  if (existing) {
    if (email) {
      await db
        .update(users)
        .set({ email, updatedAt: now })
        .where(and(eq(users.id, existing.userId), isNull(users.email)));
    }
    return existing.userId;
  }

  const userId = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(users).values({ id: userId, email, createdAt: now, updatedAt: now }),
      db.insert(userIdentities).values({
        id: crypto.randomUUID(),
        userId,
        provider,
        subject,
        createdAt: now,
      }),
    ]);
    return userId;
  } catch (err) {
    // 同時に初回ログインした場合は、先に作られたほうを使う
    const raced = await db
      .select({ userId: userIdentities.userId })
      .from(userIdentities)
      .where(and(eq(userIdentities.provider, provider), eq(userIdentities.subject, subject)))
      .get();
    if (raced) return raced.userId;
    throw err;
  }
}

export async function createSessionRows(
  db: Db,
  params: {
    sessionId: string;
    userId: string;
    tokenHash: string;
    tokenExpiresAt: number;
    sessionExpiresAt: number;
    event: Record<string, unknown>;
    now: number;
  },
) {
  const { sessionId, userId, tokenHash, tokenExpiresAt, sessionExpiresAt, event, now } = params;
  await db.batch([
    db.insert(sessions).values({
      id: sessionId,
      userId,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: sessionExpiresAt,
    }),
    db.insert(refreshTokens).values({
      id: crypto.randomUUID(),
      sessionId,
      tokenHash,
      createdAt: now,
      expiresAt: tokenExpiresAt,
    }),
    db.insert(outbox).values(outboxRow("SessionStarted", event, now)),
  ]);
}

export async function findRefreshToken(db: Db, tokenHash: string) {
  const row = await db
    .select({ token: refreshTokens, session: sessions })
    .from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .get();
  return row ?? null;
}

export async function findRefreshTokenById(db: Db, id: string) {
  return (await db.select().from(refreshTokens).where(eq(refreshTokens.id, id)).get()) ?? null;
}

/**
 * 未使用のトークン（usedTokenId）を使用済みにし、新しいトークンへ交換する。
 * 「使用済みにする」と「次のトークンの記録」は1つの条件付きUPDATEで行う。
 * 同時に別のリクエストが使用済みにしていた場合は、新しい行を消して false を返す
 */
export async function tryRotate(
  db: Db,
  params: { usedTokenId: string; sessionId: string; tokenHash: string; expiresAt: number; now: number },
): Promise<boolean> {
  const newId = crypto.randomUUID();
  await db.insert(refreshTokens).values({
    id: newId,
    sessionId: params.sessionId,
    tokenHash: params.tokenHash,
    createdAt: params.now,
    expiresAt: params.expiresAt,
  });
  const result = await db
    .update(refreshTokens)
    .set({ usedAt: params.now, replacedBy: newId })
    .where(and(eq(refreshTokens.id, params.usedTokenId), isNull(refreshTokens.usedAt)))
    .run();
  if (result.meta.changes !== 1) {
    await db.delete(refreshTokens).where(eq(refreshTokens.id, newId));
    return false;
  }
  await db.update(sessions).set({ lastUsedAt: params.now }).where(eq(sessions.id, params.sessionId));
  return true;
}

export async function revokeSession(db: Db, sessionId: string, now: number) {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

export async function revokeAllSessions(db: Db, userId: string, now: number) {
  await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** 閲覧者自身のセッションが有効か（重要な操作で毎回確認する） */
export async function isSessionActive(db: Db, viewer: { userId: string; sessionId: string }, now: number) {
  const row = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, viewer.sessionId),
        eq(sessions.userId, viewer.userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .get();
  return row !== undefined;
}

export async function findMe(db: Db, viewerId: string) {
  const row = await db
    .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, viewerId))
    .get();
  return row ?? null;
}

