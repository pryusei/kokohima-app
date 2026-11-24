import { env } from "cloudflare:workers";
import { compactVerify, createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, type JWK, SignJWT } from "jose";
import { createApp, defaultDeps } from "../src/app";
import { LINE_ENDPOINTS, type AppDeps, type Bindings, type JobMessage } from "../src/env";
import { createFakeClaude } from "./fake-claude";
import { createFakeDelivery } from "./fake-delivery";
import { createFakeGoogle } from "./fake-google";
import { createFakeSlack } from "./fake-slack";
import { createFakeWeb } from "./fake-web";

// identity のテスト用の道具。本番のコードからは読み込まない（*.test.ts からだけ使う）

export const ORIGIN = "https://app.test";
type ProviderName = "google" | "apple" | "line";
type JwksProviderName = "google" | "apple";

/** overrides：AppDeps の一部を差し替える（問い合わせの公開の日など） */
export async function createHarness(overrides: Partial<AppDeps> = {}) {
  const clock = { now: Date.parse("2026-10-10T00:00:00Z") };
  const providerKeys = {
    google: await generateKeyPair("RS256", { extractable: true }),
    apple: await generateKeyPair("RS256", { extractable: true }),
  };
  const jwk = async (p: JwksProviderName): Promise<JWK> => ({
    ...(await exportJWK(providerKeys[p].publicKey)),
    kid: `${p}-kid`,
    alg: "RS256",
  });
  const appleSigningKey = await generateKeyPair("ES256", { extractable: true });
  /** Queue に送ったメッセージ（本物の Queue には送らない） */
  const jobs: JobMessage[] = [];
  const fakeQueue = {
    send: async (body: JobMessage) => {
      jobs.push(body);
    },
    sendBatch: async (messages: Iterable<{ body: JobMessage }>) => {
      for (const m of messages) jobs.push(m.body);
    },
  } as unknown as Queue<JobMessage>;
  const bindings: Bindings = {
    ...env,
    APPLE_PRIVATE_KEY: await exportPKCS8(appleSigningKey.privateKey),
    JOBS: fakeQueue,
  };
  const google = createFakeGoogle();
  const delivery = createFakeDelivery();
  const web = createFakeWeb();
  const slack = createFakeSlack();
  const claude = createFakeClaude();

  /** 次にトークンエンドポイントが返すIDトークンの作り方。テストごとに差し替える */
  let tokenResponder: (req: { provider: ProviderName; body: URLSearchParams }) => Promise<Response> = async () =>
    new Response("not configured", { status: 500 });
  const tokenRequests: { provider: ProviderName; body: URLSearchParams }[] = [];

  // LINE の IDトークンの検証のエンドポイント（T-32）。既定は本物に近い形：チャネルシークレットの HS256 の署名だけを確かめ、
  // ペイロードをそのまま返す（発行者・宛先・期限・nonce のこちら側の確かめをテストできるよう、それらは確かめない）
  const lineSecret = () => new TextEncoder().encode(bindings.LINE_CHANNEL_SECRET ?? "");
  const defaultVerifyResponder = async (body: URLSearchParams): Promise<Response> => {
    try {
      const { payload } = await compactVerify(body.get("id_token") ?? "", lineSecret(), { algorithms: ["HS256"] });
      return Response.json(JSON.parse(new TextDecoder().decode(payload)));
    } catch {
      return Response.json({ error: "invalid_request", error_description: "Invalid IdToken." }, { status: 400 });
    }
  };
  let verifyResponder = defaultVerifyResponder;
  const verifyRequests: URLSearchParams[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (google.handles(new URL(url), init)) return google.handle(new URL(url), init);
    if (delivery.handles(new URL(url))) return delivery.handle(new URL(url), init);
    if (web.handles(new URL(url))) return web.handle(new URL(url), init);
    if (slack.handles(new URL(url))) return slack.handle(new URL(url), init);
    if (claude.handles(new URL(url))) return claude.handle(new URL(url), init);
    if (url === LINE_ENDPOINTS.verify) {
      const body = new URLSearchParams(String(init?.body ?? ""));
      verifyRequests.push(body);
      return verifyResponder(body);
    }
    const provider: ProviderName | null = url.startsWith("https://oauth2.googleapis.com/token")
      ? "google"
      : url.startsWith("https://appleid.apple.com/auth/token")
        ? "apple"
        : url === LINE_ENDPOINTS.token
          ? "line"
          : null;
    if (!provider) throw new Error(`unexpected fetch: ${url}`);
    const body = new URLSearchParams(String(init?.body ?? ""));
    tokenRequests.push({ provider, body });
    return tokenResponder({ provider, body });
  };

  // 回数の上限の判定をテストから差し替える口（T-10）。null なら本物のバインディング（Miniflare）を使う
  const limiter: { allow: null | ((limiter: string, key: string) => boolean); calls: { limiter: string; key: string }[] } = {
    allow: null,
    calls: [],
  };
  const base = defaultDeps();
  const deps: AppDeps = {
    ...base,
    rateLimit: async (env, name, key) => {
      limiter.calls.push({ limiter: name, key });
      return limiter.allow ? limiter.allow(name, key) : base.rateLimit(env, name, key);
    },
    fetch: fakeFetch,
    jwks: {
      google: createLocalJWKSet({ keys: [await jwk("google")] }),
      apple: createLocalJWKSet({ keys: [await jwk("apple")] }),
    },
    now: () => clock.now,
    // テストではタイムアウトを短くする（タイムアウトのテストを速くするため）
    linkPreview: { ...base.linkPreview, timeouts: { fetchMs: 300, totalMs: 600, dnsMs: 300 } },
    wishSuggest: { timeoutMs: 500 },
    ...overrides,
  };
  const app = createApp(deps);

  const request = (path: string, init: RequestInit = {}) => app.request(path, init, bindings);

  async function signIdToken(
    provider: ProviderName,
    claims: Record<string, unknown>,
    opts: { alg?: string; key?: CryptoKey | Uint8Array; kid?: string } = {},
  ) {
    const iat = Math.floor(clock.now / 1000);
    if (provider === "line") {
      // LINE の Web のログインの IDトークンは、チャネルシークレットの HS256（verify のエンドポイントの偽物が確かめる）
      return new SignJWT({ iss: "https://access.line.me", aud: bindings.LINE_CHANNEL_ID, iat, exp: iat + 3600, amr: ["linesso"], ...claims })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .sign(opts.key ?? lineSecret());
    }
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
    if (provider === "google" || provider === "line") {
      return request(`/api/v1/auth/${provider}/callback?${new URLSearchParams(params)}`, { headers });
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
    google,
    delivery,
    web,
    slack,
    claude,
    jobs,
    deps,
    limiter,
    /** consumer・Cron の処理を呼ぶときの ctx */
    ctx: { env: bindings, deps },
    clock,
    request,
    tokenRequests,
    verifyRequests,
    setVerifyResponder: (r: typeof verifyResponder | null) => {
      verifyResponder = r ?? defaultVerifyResponder;
    },
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
