import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, type JWK, SignJWT } from "jose";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";

// identity のテスト用の道具。本番のコードからは読み込まない（*.test.ts からだけ使う）

export const ORIGIN = "https://app.test";
type ProviderName = "google" | "apple";

export async function createHarness() {
  const clock = { now: Date.parse("2026-10-10T00:00:00Z") };
  const providerKeys = {
    google: await generateKeyPair("RS256", { extractable: true }),
    apple: await generateKeyPair("RS256", { extractable: true }),
  };
  const jwk = async (p: ProviderName): Promise<JWK> => ({
    ...(await exportJWK(providerKeys[p].publicKey)),
    kid: `${p}-kid`,
    alg: "RS256",
  });
  const appleSigningKey = await generateKeyPair("ES256", { extractable: true });
  const bindings: Bindings = { ...env, APPLE_PRIVATE_KEY: await exportPKCS8(appleSigningKey.privateKey) };

  /** 次にトークンエンドポイントが返すIDトークンの作り方。テストごとに差し替える */
  let tokenResponder: (req: { provider: ProviderName; body: URLSearchParams }) => Promise<Response> = async () =>
    new Response("not configured", { status: 500 });
  const tokenRequests: { provider: ProviderName; body: URLSearchParams }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const provider: ProviderName | null = url.startsWith("https://oauth2.googleapis.com/token")
      ? "google"
      : url.startsWith("https://appleid.apple.com/auth/token")
        ? "apple"
        : null;
    if (!provider) throw new Error(`unexpected fetch: ${url}`);
    const body = new URLSearchParams(String(init?.body ?? ""));
    tokenRequests.push({ provider, body });
    return tokenResponder({ provider, body });
  };

  const app = createApp({
    fetch: fakeFetch,
    jwks: {
      google: createLocalJWKSet({ keys: [await jwk("google")] }),
      apple: createLocalJWKSet({ keys: [await jwk("apple")] }),
    },
    now: () => clock.now,
  });

  const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings);

  async function signIdToken(
    provider: ProviderName,
    claims: Record<string, unknown>,
    opts: { alg?: string; key?: CryptoKey; kid?: string } = {},
  ) {
    const iat = Math.floor(clock.now / 1000);
    return new SignJWT({
      iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
      aud: provider === "google" ? env.GOOGLE_CLIENT_ID : env.APPLE_CLIENT_ID,
      iat,
      exp: iat + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? `${provider}-kid` })
      .sign(opts.key ?? providerKeys[provider].privateKey);
  }

  function respondWithIdToken(make: (provider: ProviderName) => Promise<string>) {
    tokenResponder = async ({ provider }) =>
      Response.json({ access_token: "unused", token_type: "Bearer", id_token: await make(provider) });
  }

  /** /start を呼び、認可画面のURLと結びつけCookieを返す */
  async function start(provider: ProviderName, returnTo?: string) {
    const q = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    const res = await request(`/api/v1/auth/${provider}/start${q}`);
    const location = new URL(res.headers.get("Location") ?? "");
    return {
      res,
      location,
      state: location.searchParams.get("state") ?? "",
      nonce: location.searchParams.get("nonce") ?? "",
      binding: cookieValue(res, "__Host-kh_oauth") ?? "",
    };
  }

  async function callback(provider: ProviderName, params: Record<string, string>, binding?: string) {
    const headers: Record<string, string> = binding ? { Cookie: `__Host-kh_oauth=${binding}` } : {};
    if (provider === "google") {
      return request(`/api/v1/auth/google/callback?${new URLSearchParams(params)}`, { headers });
    }
    return request("/api/v1/auth/apple/callback", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  async function complete(code: string, binding?: string, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (origin) headers.Origin = origin;
    if (binding) headers.Cookie = `__Host-kh_oauth=${binding}`;
    return request("/api/v1/auth/complete", { method: "POST", headers, body: JSON.stringify({ code }) });
  }

  /** ログインを最後まで通し、アクセストークンと更新用トークンを返す */
  async function login(
    provider: ProviderName,
    sub: string,
    extraClaims: Record<string, unknown> = {},
    returnTo?: string,
  ) {
    const s = await start(provider, returnTo);
    respondWithIdToken((p) => signIdToken(p, { sub, nonce: s.nonce, ...extraClaims }));
    const cb = await callback(provider, { code: "auth-code", state: s.state }, s.binding);
    const loginCode = completeCodeFrom(cb);
    if (!loginCode) throw new Error(`callback failed: ${cb.headers.get("Location")}`);
    const res = await complete(loginCode, s.binding);
    if (res.status !== 200) throw new Error(`complete failed: ${res.status}`);
    const body = (await res.json()) as { accessToken: string; expiresAt: string; returnTo: string };
    return { ...body, refreshToken: cookieValue(res, "__Host-kh_rt") ?? "", response: res };
  }

  async function refresh(token: string | undefined, origin: string | null = ORIGIN) {
    const headers: Record<string, string> = {};
    if (origin) headers.Origin = origin;
    if (token) headers.Cookie = `__Host-kh_rt=${token}`;
    return request("/api/v1/auth/refresh", { method: "POST", headers });
  }

  return {
    app,
    bindings,
    clock,
    request,
    tokenRequests,
    appleSigningKey,
    signIdToken,
    respondWithIdToken,
    setTokenResponder: (r: typeof tokenResponder) => {
      tokenResponder = r;
    },
    start,
    callback,
    complete,
    login,
    refresh,
  };
}

export function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

export function cookieHeader(res: Response, name: string): string | undefined {
  return setCookies(res).find((c) => c.startsWith(`${name}=`));
}

/** Set-Cookie の値（削除の Set-Cookie は空文字） */
export function cookieValue(res: Response, name: string): string | undefined {
  const header = cookieHeader(res, name);
  return header?.slice(name.length + 1).split(";")[0];
}

export function completeCodeFrom(res: Response): string | null {
  const location = res.headers.get("Location") ?? "";
  const match = location.match(/^\/auth\/complete#code=(.+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
