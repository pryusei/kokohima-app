import { WISH_MAX_ACTIVE, WISH_MAX_POSTS_PER_DAY } from "@kokohima/shared";

// 行きたいの規則（docs/specs/T-22-wishlist.md「振る舞い」）。Cloudflare・D1 に依存しない

export const DAY_MS = 24 * 60 * 60 * 1000;
export { WISH_MAX_ACTIVE, WISH_MAX_POSTS_PER_DAY };

/** 置く回数を数える窓の始まり（この時刻より後に置いた記録を数える） */
export const postWindowStart = (now: number) => now - DAY_MS;

/** 置く回数の429の Retry-After：いちばん古い記録が24時間を過ぎるまでの秒数（切り上げ、最低1秒） */
export function retryAfterSeconds(oldestPostAt: number, now: number) {
  return Math.max(1, Math.ceil((oldestPostAt + DAY_MS - now) / 1000));
}

/**
 * 置けなかった理由（判定の順番：見せない相手 → 件数 → 回数）。
 * どれにも当たらない（同時に消されたなど）ときは null（呼び出し側で1回だけやり直す）
 */
export type Blocked = { kind: "not_found" } | { kind: "too_many" } | { kind: "rate_limited"; retryAfterSeconds: number };

export function blockedReason(
  s: { exclusionsValid: boolean; activeCount: number; postsInWindow: number; oldestPostAt: number | null },
  now: number,
): Blocked | null {
  if (!s.exclusionsValid) return { kind: "not_found" };
  if (s.activeCount >= WISH_MAX_ACTIVE) return { kind: "too_many" };
  if (s.postsInWindow >= WISH_MAX_POSTS_PER_DAY) {
    return { kind: "rate_limited", retryAfterSeconds: retryAfterSeconds(s.oldestPostAt ?? now, now) };
  }
  return null;
}

/** 見せない相手の一覧が受け付けられるか：自分を含まず、全員が今の友達（友達の数は SQL で数えて渡す） */
export const exclusionsValid = (viewerId: string, ids: readonly string[], mutualFriendCount: number) =>
  !ids.includes(viewerId) && mutualFriendCount === ids.length;
