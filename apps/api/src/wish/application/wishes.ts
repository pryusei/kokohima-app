import type { CreateWishRequest, LinkPreview, PublicProfile, Wish } from "@kokohima/shared";
import { createWishRequestSchema } from "@kokohima/shared";
import type { z } from "zod";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles } from "../../identity/application/auth";
import { previewsFor } from "../../link-preview/application/previews";
import { RETENTION, RETENTION_UNIT_MS } from "@kokohima/shared";
import {
  blockedReason,
  exclusionsValid,
  postWindowStart,
  WISH_MAX_ACTIVE,
  WISH_MAX_POSTS_PER_DAY,
  type Blocked,
} from "../domain/wish";
import * as repo from "../infra/repository";

// 行きたい（docs/specs/T-22-wishlist.md）。状態の遷移はない（置く・見せない相手を変える・消す）

type Ctx = { env: Bindings; deps: AppDeps };
type CreateWish = z.infer<typeof createWishRequestSchema>;
export type { CreateWishRequest };

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 行の DTO。プロフィールとプレビューは、閲覧者で絞って読んだ行の ID でだけ取る。
 * excludedUsers は置いた人（forOwner）にだけ配列で返す
 */
async function toDtos(ctx: Ctx, viewerId: string, rows: repo.WishRow[], forOwner: string | null): Promise<Wish[]> {
  if (rows.length === 0) return [];
  const d1 = ctx.env.DB;
  const exclusions = forOwner ? await repo.exclusionsOf(d1, forOwner, rows.map((r) => r.id)) : [];
  const profileIds = [...new Set([...rows.map((r) => r.owner_id), ...exclusions.map((e) => e.user_id)])];
  const [profiles, previews] = await Promise.all([
    getPublicProfiles(ctx, viewerId, profileIds),
    previewsFor(
      d1,
      rows.map((r) => ({ directInviteId: null, broadcastId: null, wishId: r.id, url: r.url })),
    ) as Promise<(LinkPreview | null)[]>,
  ]);
  const excludedBy = new Map<string, PublicProfile[]>();
  for (const e of exclusions) {
    const p = profiles.get(e.user_id);
    if (!p) continue; // 退会した人は含めない
    excludedBy.set(e.wish_id, [...(excludedBy.get(e.wish_id) ?? []), p]);
  }
  return rows.flatMap((r, i) => {
    const owner = profiles.get(r.owner_id);
    if (!owner) return [];
    return [
      {
        id: r.id,
        owner,
        message: r.message,
        area: r.area,
        url: r.url,
        linkPreview: previews[i] ?? null,
        createdAt: iso(r.created_at),
        excludedUsers: forOwner === r.owner_id ? (excludedBy.get(r.id) ?? []) : null,
      },
    ];
  });
}

export type CreateResult = { kind: "created"; wish: Wish } | Blocked | { kind: "conflict" };

/** 置く。判定の順番は、入力の検証（routes）→ 見せない相手（404）→ 件数（409）→ 回数（429） */
export async function createWish(ctx: Ctx, viewerId: string, input: CreateWish): Promise<CreateResult> {
  const d1 = ctx.env.DB;
  const ids = input.excludedUserIds;
  if (!exclusionsValid(viewerId, ids, await repo.countMutualFriends(d1, viewerId, ids))) return { kind: "not_found" };

  for (let attempt = 0; attempt < 2; attempt++) {
    const now = ctx.deps.now();
    const id = crypto.randomUUID();
    const windowStart = postWindowStart(now);
    const ok = await repo.insertWish(
      d1,
      { id, ownerId: viewerId, message: input.message as string, area: input.area, url: input.url, excludedUserIds: ids, now },
      { maxActive: WISH_MAX_ACTIVE, maxPosts: WISH_MAX_POSTS_PER_DAY, windowStart },
    );
    if (ok) {
      const row = await repo.findMine(d1, viewerId, id);
      const [wish] = row ? await toDtos(ctx, viewerId, [row], viewerId) : [];
      // 書いた直後に消された（同時の DELETE）ときは、書けなかったのと同じに扱う
      if (wish) return { kind: "created", wish };
      return { kind: "conflict" };
    }
    // 書けなかった理由を読み直す（同時に友達を解除された・置かれたときも、上限を超えない）
    const valid = exclusionsValid(viewerId, ids, await repo.countMutualFriends(d1, viewerId, ids));
    const blocked = blockedReason({ exclusionsValid: valid, ...(await repo.postStats(d1, viewerId, windowStart)) }, now);
    if (blocked) return blocked;
  }
  return { kind: "conflict" };
}

export function listMine(ctx: Ctx, viewerId: string) {
  return repo.listMine(ctx.env.DB, viewerId).then((rows) => toDtos(ctx, viewerId, rows, viewerId));
}

/** 1件：自分のもの、または見られる友達のもの。どちらでもなければ null（同じ404にする） */
export async function getWish(ctx: Ctx, viewerId: string, id: string) {
  const row = await repo.findForViewer(ctx.env.DB, viewerId, id);
  if (!row) return null;
  const [wish] = await toDtos(ctx, viewerId, [row], row.owner_id === viewerId ? viewerId : null);
  return wish ?? null;
}

export type UpdateExclusionsResult = { kind: "ok"; wish: Wish } | { kind: "not_found" };

/** 見せない相手を置き換える。自分の行きたいで、一覧が全員今の友達のときだけ */
export async function updateExclusions(ctx: Ctx, viewerId: string, id: string, userIds: string[]): Promise<UpdateExclusionsResult> {
  const d1 = ctx.env.DB;
  if (!(await repo.findMine(d1, viewerId, id))) return { kind: "not_found" };
  if (!exclusionsValid(viewerId, userIds, await repo.countMutualFriends(d1, viewerId, userIds))) return { kind: "not_found" };
  await repo.replaceExclusions(d1, viewerId, id, userIds, ctx.deps.now());
  const row = await repo.findMine(d1, viewerId, id);
  const [wish] = row ? await toDtos(ctx, viewerId, [row], viewerId) : [];
  return wish ? { kind: "ok", wish } : { kind: "not_found" };
}

export const deleteWish = (ctx: Ctx, viewerId: string, id: string) => repo.deleteMine(ctx.env.DB, viewerId, id);

/** 友達1人の行きたい。友達（両方向）でなければ null */
export async function friendWishes(ctx: Ctx, viewerId: string, friendId: string) {
  const d1 = ctx.env.DB;
  if (!(await repo.isMutualFriend(d1, viewerId, friendId))) return null;
  return toDtos(ctx, viewerId, await repo.listVisibleOf(d1, viewerId, friendId), null);
}

/** 「みんな」の友達の行きたい（友達ごと。並びは友達の一覧と同じ） */
export async function friendWishGroups(ctx: Ctx, viewerId: string, limit: number, cursor: { k: number; id: string } | null) {
  const d1 = ctx.env.DB;
  const friends = await repo.friendsWithWishes(d1, viewerId, limit, cursor);
  const page = friends.slice(0, limit);
  const wishes = await toDtos(ctx, viewerId, await repo.visibleWishesOf(d1, viewerId, page.map((f) => f.friend_id)), null);
  const byOwner = new Map<string, Wish[]>();
  for (const w of wishes) byOwner.set(w.owner.id, [...(byOwner.get(w.owner.id) ?? []), w]);
  const last = page.at(-1);
  return {
    items: page.flatMap((f) => {
      const list = byOwner.get(f.friend_id);
      // プロフィールがない（退会した人）・読み取りの間に消えた友達は出さない
      return list && list.length > 0 ? [{ friend: list[0]!.owner, wishes: list }] : [];
    }),
    next: friends.length > limit && last ? { k: last.created_at, id: last.friend_id } : null,
  };
}

/** LinkAttached の行きたいのリンク（閲覧者のいない consumer 用。T-08） */
export const linkOfWish = (ctx: Ctx, id: string) => repo.linkOf(ctx.env.DB, id);

/** 退会（T-16）：入口を止める段の batch に入れる文 */
export const withdrawalPurgeStatements = (d1: D1Database, userId: string) => repo.withdrawalPurgeStatements(d1, userId);

/** 置いた記録を残す期間（T-17） */
export const WISH_POSTS_RETENTION_MS = RETENTION.wishPostsDays * RETENTION_UNIT_MS.day;

/** 掃除（T-17）：2日を過ぎた置いた記録を消す */
export const deleteOldPosts = (d1: D1Database, now: number, limit: number) =>
  repo.deletePostsBefore(d1, now - WISH_POSTS_RETENTION_MS, limit);
