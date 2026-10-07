// 更新用トークンの判定（docs/specs/T-01-auth.md「更新」）。D1には触れない純粋な関数

export type TokenState = {
  expiresAt: number;
  usedAt: number | null;
};

export type SessionState = {
  expiresAt: number;
  revokedAt: number | null;
};

export type RefreshDecision =
  /** 未使用のトークン：使用済みにして交換する */
  | { kind: "rotate" }
  /** 使用済みだが次のトークンが未使用：前回の応答が届かなかったとみなし、次のトークンを使用済みにして交換する */
  | { kind: "rescue" }
  /** 再利用：セッションごと失効させる */
  | { kind: "reuse" }
  /** 期限切れ・失効済み：拒否するだけ */
  | { kind: "reject" };

export function decideRefresh(
  token: TokenState,
  session: SessionState,
  successor: TokenState | null,
  now: number,
): RefreshDecision {
  if (session.revokedAt !== null || session.expiresAt <= now) return { kind: "reject" };
  if (token.usedAt === null) {
    return token.expiresAt <= now ? { kind: "reject" } : { kind: "rotate" };
  }
  if (successor && successor.usedAt === null) return { kind: "rescue" };
  return { kind: "reuse" };
}

/** 新しいトークンの期限：min(今＋30日, セッションの絶対期限) */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function nextTokenExpiry(now: number, sessionExpiresAt: number): number {
  return Math.min(now + REFRESH_TOKEN_TTL_MS, sessionExpiresAt);
}
