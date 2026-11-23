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

/** 使用済みのトークンを救済できる期間（使用済みにしてから）。応答が届かなかった場合のためだけの猶予 */
export const RESCUE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
  // 救済は使用済みにしてから一定時間だけ。過ぎた使用済みトークンは、後から手に入れた人の可能性があるので再利用として扱う
  if (successor && successor.usedAt === null && now - token.usedAt < RESCUE_WINDOW_MS) {
    return successor.expiresAt <= now ? { kind: "reject" } : { kind: "rescue" };
  }
  return { kind: "reuse" };
}

/** 交換に負けたやり直しで、系列をたどる上限（提示されたトークンの次から数える） */
export const RACED_CHAIN_LIMIT = 4;

export type RacedRefreshDecision =
  /** chain[index] のトークンを、印を付けずに救済で交換する */
  | { kind: "rescue"; index: number }
  /** 拒否するだけ（失効させない） */
  | { kind: "reject" };

/**
 * 交換に負けたやり直し（同じリクエストの中で、同時に使われたことを確認済み）で、`decideRefresh` が再利用と判定したときの判定。
 * 3つ以上の更新が同時に来ると、提示されたトークンもその次も使用済みに見えるが、再利用ではないので失効させない。
 * chain は提示されたトークンの次から `replaced_by` をたどった順（最大 RACED_CHAIN_LIMIT 本）。
 * 最初の未使用のトークンを救済する。見つからない・期限切れ・失効済みなら拒否する（docs/specs/T-01-auth.md「更新」）
 */
export function decideRacedRefresh(
  chain: readonly TokenState[],
  session: SessionState,
  now: number,
): RacedRefreshDecision {
  if (session.revokedAt !== null || session.expiresAt <= now) return { kind: "reject" };
  const index = chain.slice(0, RACED_CHAIN_LIMIT).findIndex((t) => t.usedAt === null);
  if (index < 0) return { kind: "reject" };
  const latest = chain[index];
  return latest && latest.expiresAt > now ? { kind: "rescue", index } : { kind: "reject" };
}

/** 新しいトークンの期限：min(今＋30日, セッションの絶対期限) */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function nextTokenExpiry(now: number, sessionExpiresAt: number): number {
  return Math.min(now + REFRESH_TOKEN_TTL_MS, sessionExpiresAt);
}
