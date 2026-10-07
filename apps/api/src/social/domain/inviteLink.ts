// 招待リンクのルール（docs/specs/T-02-friends.md「振る舞い」）。D1には触れない純粋な関数

export const DAY_MS = 24 * 60 * 60 * 1000;
export const ISSUE_LIMIT_PER_DAY = 20;

export type InviteLinkState = {
  maxUses: number;
  uses: number;
  expiresAt: number;
  revokedAt: number | null;
};

/** 使えるリンクか（無効化されておらず、期限内で、上限に達していない） */
export function isUsable(link: InviteLinkState, now: number): boolean {
  return link.revokedAt === null && link.expiresAt > now && link.uses < link.maxUses;
}

export function expiresAt(now: number, expiresInDays: number): number {
  return now + expiresInDays * DAY_MS;
}

/**
 * 直近24時間の発行の作成日時から、発行できるかを判定する。
 * できなければ、一番古い発行から24時間たつまでの秒数（Retry-After）を返す
 */
export function issueRetryAfterSeconds(recentCreatedAts: number[], now: number): number | null {
  const recent = recentCreatedAts.filter((t) => t > now - DAY_MS);
  if (recent.length < ISSUE_LIMIT_PER_DAY) return null;
  const oldest = Math.min(...recent);
  return Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000));
}
