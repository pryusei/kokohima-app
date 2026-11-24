import type { Context } from "hono";
import type { AppEnv, LineEndpoints } from "../env";
import { problem } from "../http/problem";

// E2E用の偽の LINE ログイン（docs/specs/T-32-line-login.md「E2E用の偽の LINE」）。src/e2e/entry.ts と単体テストからだけ読み込む
// 認可の画面は同意したことにしてすぐコールバックへ戻す。利用者（sub）は毎回新しく作る（テストごとに一意な利用者）

export const E2E_LINE_HOST = "line.e2e.invalid";

export const E2E_LINE_ENDPOINTS: LineEndpoints = {
  // 利用者のブラウザが画面遷移する先。API（wrangler dev --env e2e）の偽の認可画面
  authorize: "http://localhost:8787/__e2e__/line/authorize",
  token: `https://${E2E_LINE_HOST}/oauth2/v2.1/token`,
  verify: `https://${E2E_LINE_HOST}/oauth2/v2.1/verify`,
};

const CODE_PREFIX = "e2e-line-";
const TOKEN_PREFIX = "e2e-line-id-token.";

const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

/** 偽の認可画面：sub と nonce を認可コードに入れ、コールバックへ戻す。宛先は APP_ORIGIN の下だけ */
export async function e2eLineAuthorize(c: Context<AppEnv>) {
  const redirectUri = c.req.query("redirect_uri") ?? "";
  const state = c.req.query("state") ?? "";
  const nonce = c.req.query("nonce") ?? "";
  if (!redirectUri.startsWith(`${c.env.APP_ORIGIN}/`) || !state || !nonce || c.req.query("code_challenge_method") !== "S256") {
    return problem(c.get("requestId"), 404, "not_found", "Not Found");
  }
  const back = new URL(redirectUri);
  const sub = `Ue2e${crypto.randomUUID().replace(/-/g, "")}`;
  back.searchParams.set("code", `${CODE_PREFIX}${b64(JSON.stringify({ sub, nonce }))}`);
  back.searchParams.set("state", state);
  return c.redirect(back.toString(), 302);
}

const formOf = (init: RequestInit | undefined) =>
  new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");

/** 偽の token・verify のエンドポイント。届いた宛先が偽の LINE でなければ null */
export function e2eLineFetch(url: URL, init: RequestInit | undefined, channelId: string, now: number): Response | null {
  if (url.host !== E2E_LINE_HOST) return null;
  const form = formOf(init);
  if (url.pathname === "/oauth2/v2.1/token") {
    const code = form.get("code") ?? "";
    if (!code.startsWith(CODE_PREFIX) || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json({ access_token: "e2e-unused", token_type: "Bearer", id_token: `${TOKEN_PREFIX}${code.slice(CODE_PREFIX.length)}` });
  }
  if (url.pathname === "/oauth2/v2.1/verify") {
    const token = form.get("id_token") ?? "";
    if (!token.startsWith(TOKEN_PREFIX) || form.get("client_id") !== channelId) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const { sub, nonce } = JSON.parse(unb64(token.slice(TOKEN_PREFIX.length))) as { sub: string; nonce: string };
    if (form.get("nonce") !== nonce) return Response.json({ error: "invalid_request" }, { status: 400 });
    const iat = Math.floor(now / 1000);
    return Response.json({ iss: "https://access.line.me", sub, aud: channelId, exp: iat + 3600, iat, nonce, amr: ["linesso"] });
  }
  return Response.json({}, { status: 404 });
}
