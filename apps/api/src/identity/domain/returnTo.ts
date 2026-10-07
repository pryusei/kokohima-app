// ログイン後の戻り先の検証（docs/specs/T-01-auth.md「API」の returnTo）
// 満たさなければエラーにせず "/" に置き換える

const MAX_LENGTH = 512;
// 制御文字（U+0000〜U+001F、U+007F）、空白、バックスラッシュ
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\s\\]/;
// /api/ と、/__ で始まる予約済みのパス（テスト用の経路など）には戻さない
const BLOCKED_PREFIXES = ["/api/", "/__"];

export function sanitizeReturnTo(value: string | null | undefined, appOrigin: string): string {
  if (!value) return "/";
  if (value.length > MAX_LENGTH) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (FORBIDDEN.test(value)) return "/";
  if (value === "/api" || BLOCKED_PREFIXES.some((p) => value.startsWith(p))) return "/";
  let url: URL;
  try {
    url = new URL(value, appOrigin);
  } catch {
    return "/";
  }
  if (url.origin !== new URL(appOrigin).origin) return "/";
  return value;
}
