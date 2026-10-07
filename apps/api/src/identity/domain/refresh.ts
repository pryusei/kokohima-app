// 更新用トークンの判定（docs/specs/T-01-auth.md「更新」）。D1には触れない純粋な関数

export type TokenState = {
  expiresAt: number;
  usedAt: number | null;
  /** 救済で使用済みにされた時刻。届かなかったはずのトークンなので、提示されたら盗まれたとみなす */
  rescuedAt?: number | null;
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
  // 期限切れ・失効済みは、使用済みかどうかに関係なく先に拒否する（仕様書「更新」の手順3）
  if (session.revokedAt !== null || session.expiresAt <= now || token.expiresAt <= now) {
    return { kind: "reject" };
  }
  if (token.usedAt === null) return { kind: "rotate" };
  // 救済で使用済みにしたトークンは正規の利用者には届いていない。提示されたら再利用
  if (token.rescuedAt != null) return { kind: "reuse" };
  if (successor && successor.usedAt === null) {
    return successor.expiresAt <= now ? { kind: "reject" } : { kind: "rescue" };
  }
  return { kind: "reuse" };
}

/** 新しいトークンの期限：min(今＋30日, セッションの絶対期限) */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function nextTokenExpiry(now: number, sessionExpiresAt: number): number {
  return Math.min(now + REFRESH_TOKEN_TTL_MS, sessionExpiresAt);
}
