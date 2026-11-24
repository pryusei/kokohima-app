// LINE の IDトークンの検証の結果（verify のエンドポイントの応答）を、こちらでも確かめる（docs/specs/T-32-line-login.md「4.」）
// 署名は LINE の verify のエンドポイントが確かめる。ここでは発行者・宛先・期限・sub の形を確かめる（nonce は infra で定数時間で比べる）

export const LINE_ISSUER = "https://access.line.me";
/** 時計のずれの許容（秒）。Google・Apple の検証と同じ */
export const LINE_CLOCK_TOLERANCE_SEC = 60;

export type LineClaims = { sub: string; nonce: string };

/** 問題がなければ sub と nonce を返し、あれば失敗の種類（ログに出す短い名前）を返す */
export function checkLineClaims(
  payload: unknown,
  expected: { channelId: string; now: number },
): { ok: true; claims: LineClaims } | { ok: false; reason: string } {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "id_token_invalid" };
  const p = payload as Record<string, unknown>;
  if (p.iss !== LINE_ISSUER) return { ok: false, reason: "id_token_invalid" };
  if (typeof p.aud !== "string" || p.aud.length === 0 || p.aud !== expected.channelId) {
    return { ok: false, reason: "id_token_invalid" };
  }
  const nowSec = expected.now / 1000;
  if (typeof p.exp !== "number" || p.exp + LINE_CLOCK_TOLERANCE_SEC <= nowSec) return { ok: false, reason: "id_token_invalid" };
  if (typeof p.iat !== "number" || p.iat - LINE_CLOCK_TOLERANCE_SEC > nowSec) return { ok: false, reason: "id_token_invalid" };
  if (typeof p.nonce !== "string" || p.nonce.length === 0) return { ok: false, reason: "nonce_mismatch" };
  if (typeof p.sub !== "string" || p.sub.length === 0 || p.sub.length > 255) return { ok: false, reason: "sub_invalid" };
  return { ok: true, claims: { sub: p.sub, nonce: p.nonce } };
}
