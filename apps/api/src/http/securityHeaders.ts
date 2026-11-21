// ブラウザ向けのセキュリティのヘッダー（docs/specs/T-12-release.md「セキュリティのヘッダー」）。
// 振り分け（API か画面か）とヘッダーの選び方は、同じ isApiPath で決める

/** API の経路か。URL.pathname をデコードせずに見る（`/api`・`/%61pi/`・`/API/` は画面の側に倒れる） */
export const isApiPath = (pathname: string) => pathname.startsWith("/api/");

export const COMMON_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/** 画面の側（`/api/` 以外）の応答の CSP。インラインの script・style と、外のオリジンからの読み込みを許さない */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

/** API の応答の CSP（JSON をブラウザで開いても何も読み込ませない） */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** 応答のヘッダーを変えられるように作り直す（ASSETS・fetch の応答のヘッダーは変えられないことがある） */
const mutable = (res: Response) => new Response(res.body, res);

/** API の応答：経路がすでに付けたヘッダーは上書きしない */
export function withApiHeaders(res: Response): Response {
  const out = mutable(res);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  if (!out.headers.has("Content-Security-Policy")) out.headers.set("Content-Security-Policy", API_CSP);
  return out;
}

/** SPA の入口（HTML）か。304 などで Content-Type がなければ、パスで決める */
function isHtml(pathname: string, res: Response) {
  const type = res.headers.get("Content-Type");
  if (type) return type.split(";")[0]?.trim().toLowerCase() === "text/html";
  const last = pathname.split("/").pop() ?? "";
  return pathname.endsWith("/") || last.endsWith(".html") || !last.includes(".");
}

/** 画面の側の応答：セキュリティのヘッダーは常に上書きする。`Cache-Control` は `/sw.js` と HTML だけ no-cache にする */
export function withPageHeaders(pathname: string, res: Response): Response {
  const out = mutable(res);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) out.headers.set(k, v);
  out.headers.set("Content-Security-Policy", PAGE_CSP);
  if (pathname === "/sw.js" || isHtml(pathname, res)) out.headers.set("Cache-Control", "no-cache");
  return out;
}
