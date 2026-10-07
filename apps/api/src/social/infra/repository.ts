import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Cursor } from "../../shared/cursor";
import { friendships, inviteLinks } from "./schema";

// social のD1アクセス。条件つきの消費は単独で実行し、結果を見てから残りを書く

export type Db = DrizzleD1Database;
export const db = (d1: D1Database): Db => drizzle(d1);

/**
 * 直近24時間（since 以降）に作った本数が limit 未満のときだけ、1つの文で追加する。
 * 数えてから追加するまでの間に同時に送られても、上限を超えない。追加できたら true
 */
export async function insertInviteLinkWithinLimit(
  db: Db,
  row: Required<Omit<typeof inviteLinks.$inferInsert, "revokedAt">>,
  since: number,
  limit: number,
) {
  const result = await db.run(sql`
    INSERT INTO invite_links (id, owner_id, token_hash, max_uses, uses, expires_at, created_at)
    SELECT ${row.id}, ${row.ownerId}, ${row.tokenHash}, ${row.maxUses}, ${row.uses}, ${row.expiresAt}, ${row.createdAt}
    WHERE (SELECT COUNT(*) FROM invite_links WHERE owner_id = ${row.ownerId} AND created_at > ${since}) < ${limit}
  `);
  return result.meta.changes === 1;
}

/** 閲覧者が直近（since 以降）に作った招待リンクの作成日時（無効化したものも数える） */
export async function recentInviteCreatedAts(db: Db, ownerId: string, since: number) {
  const rows = await db
    .select({ createdAt: inviteLinks.createdAt })
    .from(inviteLinks)
    .where(and(eq(inviteLinks.ownerId, ownerId), gt(inviteLinks.createdAt, since)));
  return rows.map((r) => r.createdAt);
}

/** 閲覧者の有効なリンク（作成日時の新しい順、同じなら id の降順） */
export async function listUsableInviteLinks(db: Db, ownerId: string, now: number, limit: number, cursor: Cursor | null) {
  return db
    .select()
    .from(inviteLinks)
    .where(
      and(
        eq(inviteLinks.ownerId, ownerId),
        isNull(inviteLinks.revokedAt),
        gt(inviteLinks.expiresAt, now),
        lt(inviteLinks.uses, inviteLinks.maxUses),
        cursor
          ? or(
              lt(inviteLinks.createdAt, cursor.k),
              and(eq(inviteLinks.createdAt, cursor.k), lt(inviteLinks.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(inviteLinks.createdAt), desc(inviteLinks.id))
    .limit(limit + 1);
}

/** 閲覧者のリンクだけを無効化する。閲覧者のリンクなら（無効化済みでも）true */
export async function revokeOwnInviteLink(db: Db, ownerId: string, id: string, now: number) {
  const own = await db
    .select({ id: inviteLinks.id })
    .from(inviteLinks)
    .where(and(eq(inviteLinks.id, id), eq(inviteLinks.ownerId, ownerId)))
    .get();
  if (!own) return false;
  await db
    .update(inviteLinks)
    .set({ revokedAt: now })
    .where(and(eq(inviteLinks.id, id), eq(inviteLinks.ownerId, ownerId), isNull(inviteLinks.revokedAt)));
  return true;
}

export async function findInviteLinkByTokenHash(db: Db, tokenHash: string) {
  return (await db.select().from(inviteLinks).where(eq(inviteLinks.tokenHash, tokenHash)).get()) ?? null;
}






export type AcceptOutcome = "created" | "already_friends" | "unusable";

/**
 * 「友達になる」の書き込み（人数の消費・両方向の行・FriendshipEstablished 2件）を1つのバッチ
 * （トランザクション）で行う。途中で落ちれば全部戻るので、片方向の関係は残らない。
 * D1 は書き込みを直列に処理するので、同じ人の同時の accept もバッチの途中に割り込まない。
 * 2つめ以降の文は、直前の文が1行を書いたとき（changes() = 1）だけ書く
 */
export async function acceptInBatch(
  d1: D1Database,
  params: { linkId: string; inviterId: string; acceptorId: string; now: number },
): Promise<AcceptOutcome> {
  const { linkId, inviterId, acceptorId, now } = params;
  const occurredAt = new Date(now).toISOString();
  const event = (userId: string, friendId: string) =>
    d1
      .prepare(
        "INSERT INTO outbox (id, type, payload, created_at) SELECT ?, 'FriendshipEstablished', ?, ? WHERE changes() = 1",
      )
      .bind(crypto.randomUUID(), JSON.stringify({ userId, friendId, occurredAt }), now);
  const results = await d1.batch([
    d1
      .prepare(
        `UPDATE invite_links SET uses = uses + 1
         WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?
           AND NOT EXISTS (SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?)`,
      )
      .bind(linkId, now, acceptorId, inviterId),
    d1
      .prepare("INSERT INTO friendships (user_id, friend_id, created_at) SELECT ?, ?, ? WHERE changes() = 1")
      .bind(acceptorId, inviterId, now),
    event(inviterId, acceptorId),
    event(acceptorId, inviterId),
    // 発行者側の行は最後に書く。万一すでにあっても、バッチ全体を失敗させない
    d1
      .prepare("INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) SELECT ?, ?, ? WHERE changes() = 1")
      .bind(inviterId, acceptorId, now),
  ]);
  if (results[0]?.meta.changes === 1) return "created";
  const existing = await d1
    .prepare("SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?")
    .bind(acceptorId, inviterId)
    .first();
  return existing ? "already_friends" : "unusable";
}

/** 閲覧者の友達（友達になった日時の新しい順、同じなら相手IDの降順） */
export async function listFriends(db: Db, userId: string, limit: number, cursor: Cursor | null) {
  return db
    .select({ friendId: friendships.friendId, createdAt: friendships.createdAt })
    .from(friendships)
    .where(
      and(
        eq(friendships.userId, userId),
        cursor
          ? or(
              lt(friendships.createdAt, cursor.k),
              and(eq(friendships.createdAt, cursor.k), lt(friendships.friendId, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(friendships.createdAt), desc(friendships.friendId))
    .limit(limit + 1);
}

/** 閲覧者側から見た友達関係（閲覧者の行だけを見る） */
export async function findFriendship(db: Db, userId: string, friendId: string) {
  return (
    (await db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)))
      .get()) ?? null
  );
}

/** 両方向の行を消す。閲覧者側の行がなければ false（友達でない） */
export async function deleteFriendship(db: Db, userId: string, friendId: string) {
  const results = await db.batch([
    db.delete(friendships).where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId))),
    db.delete(friendships).where(and(eq(friendships.userId, friendId), eq(friendships.friendId, userId))),
  ]);
  return results[0].meta.changes === 1;
}
