import { RETENTION, RETENTION_UNIT_MS } from "@kokohima/shared";
import { and, eq, exists, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { outboxRow } from "../../shared/outbox/schema";
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

export type Db = DrizzleD1Database & { $client: D1Database };

export function db(d1: D1Database): Db {
  return drizzle(d1);
}

export async function saveOauthTransaction(db: Db, row: typeof oauthTransactions.$inferInsert) {
  await db.insert(oauthTransactions).values(row);
}

/** 期限切れのログイン開始の記録（nonce・code_verifier を含む）とログインコードを消す */
export async function deleteExpiredLoginRecords(db: Db, now: number) {
  await db.batch([
    db.delete(oauthTransactions).where(lte(oauthTransactions.expiresAt, now)),
    db.delete(loginCodes).where(lte(loginCodes.expiresAt, now)),
  ]);
}

/** 失効・期限切れから掃除までの日数（docs/specs/T-01-auth.md「データ」） */
export const DEAD_SESSION_RETENTION_MS = RETENTION.deadSessionsDays * RETENTION_UNIT_MS.day;
/** 1回の掃除で消す行の数の上限（毎分の Cron の処理を短く保つ） */
export const SESSION_CLEANUP_LIMIT = 500;

/**
 * 失効・期限切れから30日を過ぎたセッションと、期限切れから30日を過ぎた更新用トークンを消す。
 * 利用者ごとに最初に作ったセッションの行は残す（T-07 の新端末のログインの判定 hasEarlierSession が、
 * 「その人のこれより前のセッションがあるか」で最初のログインを見分けるため）。
 * 期限切れのトークンは使用済みかどうかに関係なく拒否されるので（「更新」の手順3）、消しても振る舞いは変わらない
 */
export async function deleteDeadSessions(d1: D1Database, now: number) {
  const before = now - DEAD_SESSION_RETENTION_MS;
  await d1.batch([
    d1
      .prepare(
        `DELETE FROM sessions WHERE id IN (
           SELECT s.id FROM sessions s
           WHERE (s.revoked_at <= ?1 OR s.expires_at <= ?1)
             AND s.id <> (SELECT f.id FROM sessions f WHERE f.user_id = s.user_id ORDER BY f.created_at, f.id LIMIT 1)
           LIMIT ?2
         )`,
      )
      .bind(before, SESSION_CLEANUP_LIMIT),
    d1
      .prepare(`DELETE FROM refresh_tokens WHERE id IN (SELECT id FROM refresh_tokens WHERE expires_at <= ?1 LIMIT ?2)`)
      .bind(before, SESSION_CLEANUP_LIMIT),
  ]);
}

/** state を1回だけ取り出す（DELETE ... RETURNING）。期限切れは返さない */
export async function takeOauthTransaction(db: Db, stateHash: string, now: number) {
  const rows = await db
    .delete(oauthTransactions)
    .where(and(eq(oauthTransactions.stateHash, stateHash), gt(oauthTransactions.expiresAt, now)))
    .returning();
  return rows[0] ?? null;
}

/** 完了コードを保存する。退会した人（T-16）には作らない。作れたら true */
export async function saveLoginCode(db: Db, row: typeof loginCodes.$inferInsert) {
  const r = await db.$client
    .prepare(
      `INSERT INTO login_codes (code_hash, user_id, provider, binding_hash, return_to, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NULL)`,
    )
    .bind(row.codeHash, row.userId, row.provider, row.bindingHash, row.returnTo, row.expiresAt)
    .run();
  return r.meta.changes === 1;
}

export async function takeLoginCode(db: Db, codeHash: string, now: number) {
  const rows = await db
    .delete(loginCodes)
    .where(and(eq(loginCodes.codeHash, codeHash), gt(loginCodes.expiresAt, now)))
    .returning();
  return rows[0] ?? null;
}

/** (provider, sub) でユーザーを探し、なければ作る。確認済みのメールアドレスは、保存している値と違えばログインのたびに更新する */
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
        // 退会した人（T-16）には書き戻さない
        .where(
          and(eq(users.id, existing.userId), isNull(users.withdrawnAt), or(isNull(users.email), ne(users.email, email))),
        );
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

/**
 * セッション・更新用トークン・SessionStarted を書く。退会した人（T-16）には作らない（同時に進んでいたログインで、抜け殻に
 * セッションを作り直さない）。後続の文はセッションの行があるときだけ書く。作れたら true。
 * afterSession は、セッションの INSERT の直後に同じ batch で走らせる、ほかのコンテキストの文（セッションの行があるときだけ
 * 書く条件を、文の側に持つ。休眠中の連携を戻す文。docs/specs/T-17-retention.md「8.」）
 */
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
    afterSession?: D1PreparedStatement[];
  },
) {
  const { sessionId, userId, tokenHash, tokenExpiresAt, sessionExpiresAt, event, now, afterSession = [] } = params;
  const d1 = db.$client;
  const ev = outboxRow("SessionStarted", event, now);
  const [inserted] = await d1.batch([
    d1
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at)
         SELECT ?1, ?2, ?3, ?3, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND withdrawn_at IS NULL)`,
      )
      .bind(sessionId, userId, now, sessionExpiresAt),
    ...afterSession,
    d1
      .prepare(
        `INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2)`,
      )
      .bind(crypto.randomUUID(), sessionId, tokenHash, now, tokenExpiresAt),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?5)`,
      )
      .bind(ev.id, ev.type, ev.payload, ev.createdAt, sessionId),
  ]);
  return inserted?.meta.changes === 1;
}

export async function findRefreshToken(db: Db, tokenHash: string) {
  const row = await db
    .select({ token: refreshTokens, session: sessions })
    .from(refreshTokens)
    .innerJoin(sessions, eq(sessions.id, refreshTokens.sessionId))
    // 退会した人（T-16）のセッションは使えない
    .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.withdrawnAt)))
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
  params: {
    usedTokenId: string;
    sessionId: string;
    tokenHash: string;
    expiresAt: number;
    now: number;
    /** 救済での交換なら、使用済みにするトークンに印を残す */
    rescue: boolean;
  },
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
    .set({ usedAt: params.now, replacedBy: newId, rescuedAt: params.rescue ? params.now : null })
    .where(
      and(
        eq(refreshTokens.id, params.usedTokenId),
        isNull(refreshTokens.usedAt),
        // logout-all と同時に走っても、失効した直後のセッションでは交換しない
        exists(
          db
            .select({ id: sessions.id })
            .from(sessions)
            .where(and(eq(sessions.id, params.sessionId), isNull(sessions.revokedAt))),
        ),
      ),
    )
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
    // 退会した人（T-16）のセッションは有効でない
    .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.withdrawnAt)))
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
    // 退会した人（T-16）は404
    .where(and(eq(users.id, viewerId), isNull(users.withdrawnAt)))
    .get();
  return row ?? null;
}


/** 公開プロフィール（ID・表示名・アイコン）。他のコンテキストはこの関数を通してだけ users を読む */
export type PublicProfileRow = { id: string; displayName: string | null; avatarUrl: string | null; withdrawn: boolean };

export async function findPublicProfiles(db: Db, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, PublicProfileRow>();
  // D1のパラメータ数の上限（100）に収まるよう分けて読む
  const chunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += 90) chunks.push(userIds.slice(i, i + 90));
  const results = await Promise.all(
    chunks.map((ids) =>
      db
        .select({ id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl, withdrawnAt: users.withdrawnAt })
        .from(users)
        .where(inArray(users.id, ids)),
    ),
  );
  // 退会した人（T-16）は、列の値によらず名前とアイコンを出さない
  return new Map(
    results.flat().map((r): [string, PublicProfileRow] => {
      const withdrawn = r.withdrawnAt !== null;
      return [r.id, { id: r.id, displayName: withdrawn ? null : r.displayName, avatarUrl: withdrawn ? null : r.avatarUrl, withdrawn }];
    }),
  );
}

/** 閲覧者自身の表示名だけを更新する */
export async function updateDisplayName(db: Db, viewerId: string, displayName: string, now: number) {
  // 退会した人（T-16）には書き戻さない
  await db
    .update(users)
    .set({ displayName, updatedAt: now })
    .where(and(eq(users.id, viewerId), isNull(users.withdrawnAt)));
}

export async function findTimezone(db: Db, userId: string) {
  const row = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).get();
  return row?.timezone ?? null;
}

// ---- 通知（T-07）から使う読み取り ----

export async function findEmail(db: Db, userId: string) {
  const row = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  return row?.email ?? null;
}

/** このセッションより前に作られた、その人のセッションがあるか（失効・期限切れも数える） */
export async function hasEarlierSession(db: Db, userId: string, sessionId: string) {
  const current = await db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .get();
  if (!current) return false;
  const earlier = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, sessionId), lte(sessions.createdAt, current.createdAt)))
    .limit(1)
    .get();
  return earlier !== undefined;
}

/** 渡したセッションのうち、失効しておらず期限内のもの（requireActiveSession と同じ条件） */
export async function activeSessionIds(db: Db, sessionIds: string[], now: number) {
  if (sessionIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(inArray(sessions.id, sessionIds.slice(0, 50)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .all();
  return new Set(rows.map((r) => r.id));
}

/** 退会（T-16）：閲覧者のセッションのログインした時刻。有効なセッションでなければ null */
export async function activeSessionCreatedAt(db: Db, viewer: { userId: string; sessionId: string }, now: number) {
  const row = await db
    .select({ createdAt: sessions.createdAt })
    .from(sessions)
    .innerJoin(users, and(eq(users.id, sessions.userId), isNull(users.withdrawnAt)))
    .where(
      and(
        eq(sessions.id, viewer.sessionId),
        eq(sessions.userId, viewer.userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .get();
  return row?.createdAt ?? null;
}

/** 利用者のログインの方法（アカウント連携がないので1つ。T-16 のログインし直しで使う）。なければ null */
export async function identityProviderOf(d1: D1Database, userId: string) {
  const row = await d1.prepare("SELECT provider FROM user_identities WHERE user_id = ? LIMIT 1").bind(userId).first<{ provider: string }>();
  return row?.provider ?? null;
}

/** 本人だけに関わる outbox の型（端末の情報やここ暇の時刻が入る。T-16） */
export const PERSONAL_OUTBOX_TYPES = [
  "SessionStarted",
  "CalendarConnected",
  "CalendarReauthRequired",
  "AvailabilityCancelledByCalendar",
] as const;

/**
 * 退会（T-16 入口を止める段）：利用者の行を抜け殻にし、identity の行を消し、`UserWithdrew` を書く文。
 * 何度実行しても同じ結果になる（`withdrawn_at` は最初の時刻を残す。`UserWithdrew` は1つだけ）
 */
export function withdrawalStatements(d1: D1Database, userId: string, now: number): D1PreparedStatement[] {
  const ev = outboxRow("UserWithdrew", { userId, occurredAt: new Date(now).toISOString() }, now);
  return [
    d1
      .prepare(
        `UPDATE users SET withdrawn_at = COALESCE(withdrawn_at, ?2), display_name = NULL, avatar_url = NULL,
           email = NULL, timezone = 'Asia/Tokyo', updated_at = ?2 WHERE id = ?1`,
      )
      .bind(userId, now),
    // 更新用トークン・セッションに結びついた購読は CASCADE で消える
    d1.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM user_identities WHERE user_id = ?").bind(userId),
    d1.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(userId),
    d1
      .prepare(
        `DELETE FROM outbox WHERE type IN (SELECT value FROM json_each(?2)) AND json_extract(payload, '$.userId') = ?1`,
      )
      .bind(userId, JSON.stringify(PERSONAL_OUTBOX_TYPES)),
    d1
      .prepare(
        `INSERT INTO outbox (id, type, payload, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (
           SELECT 1 FROM outbox WHERE type = ?2 AND json_extract(payload, '$.userId') = ?5)`,
      )
      .bind(ev.id, ev.type, ev.payload, ev.createdAt, userId),
  ];
}

/** 後始末の段が終わった印（T-16） */
export async function markWithdrawalCompleted(d1: D1Database, userId: string, now: number) {
  await d1
    .prepare("UPDATE users SET withdrawal_completed_at = ?2 WHERE id = ?1 AND withdrawn_at IS NOT NULL AND withdrawal_completed_at IS NULL")
    .bind(userId, now)
    .run();
}

/** 退会から olderThan より前で、後始末が終わっていない利用者（毎分の掃除で呼び直す。T-16） */
export async function incompleteWithdrawals(d1: D1Database, olderThan: number, limit: number) {
  const { results } = await d1
    .prepare(
      `SELECT id FROM users WHERE withdrawn_at IS NOT NULL AND withdrawn_at < ? AND withdrawal_completed_at IS NULL
       ORDER BY withdrawn_at LIMIT ?`,
    )
    .bind(olderThan, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** 退会した人か（後始末の段が、退会していない人に動かないように。T-16） */
export async function isWithdrawn(d1: D1Database, userId: string) {
  const row = await d1.prepare("SELECT 1 AS x FROM users WHERE id = ? AND withdrawn_at IS NOT NULL").bind(userId).first();
  return row !== null;
}
