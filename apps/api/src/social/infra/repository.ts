import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Cursor } from "../../shared/cursor";
import { outbox, outboxRow } from "../../shared/outbox/schema";
import { friendships, inviteLinks } from "./schema";

// social のD1アクセス。条件つきの消費は単独で実行し、結果を見てから残りを書く

export type Db = DrizzleD1Database;
export const db = (d1: D1Database): Db => drizzle(d1);

export async function insertInviteLink(db: Db, row: typeof inviteLinks.$inferInsert) {
  await db.insert(inviteLinks).values(row);
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

/** 片方向の友達関係の行を書く。新しく書けたら true */
export async function insertFriendshipRow(db: Db, userId: string, friendId: string, now: number) {
  const result = await db
    .insert(friendships)
    .values({ userId, friendId, createdAt: now })
    .onConflictDoNothing()
    .run();
  return result.meta.changes === 1;
}

export async function deleteFriendshipRow(db: Db, userId: string, friendId: string) {
  await db.delete(friendships).where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)));
}

/** 人数を1消費する。使えなくなっていれば false */
export async function consumeInviteUse(db: Db, id: string, now: number) {
  const result = await db
    .update(inviteLinks)
    .set({ uses: sql`${inviteLinks.uses} + 1` })
    .where(
      and(
        eq(inviteLinks.id, id),
        lt(inviteLinks.uses, inviteLinks.maxUses),
        isNull(inviteLinks.revokedAt),
        gt(inviteLinks.expiresAt, now),
      ),
    )
    .run();
  return result.meta.changes === 1;
}

/** 発行者側の行と、両者あての FriendshipEstablished をまとめて書く */
export async function completeFriendship(db: Db, inviterId: string, acceptorId: string, now: number) {
  const occurredAt = new Date(now).toISOString();
  await db.batch([
    db.insert(friendships).values({ userId: inviterId, friendId: acceptorId, createdAt: now }).onConflictDoNothing(),
    db.insert(outbox).values(outboxRow("FriendshipEstablished", { userId: inviterId, friendId: acceptorId, occurredAt }, now)),
    db.insert(outbox).values(outboxRow("FriendshipEstablished", { userId: acceptorId, friendId: inviterId, occurredAt }, now)),
  ]);
}

export async function writeFriendshipEvents(db: Db, inviterId: string, acceptorId: string, now: number) {
  const occurredAt = new Date(now).toISOString();
  await db.batch([
    db.insert(outbox).values(outboxRow("FriendshipEstablished", { userId: inviterId, friendId: acceptorId, occurredAt }, now)),
    db.insert(outbox).values(outboxRow("FriendshipEstablished", { userId: acceptorId, friendId: inviterId, occurredAt }, now)),
  ]);
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
