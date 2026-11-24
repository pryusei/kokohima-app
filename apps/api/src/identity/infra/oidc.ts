import { importPKCS8, jwtVerify, SignJWT } from "jose";
import type { AppDeps, Bindings } from "../../env";
import { pkceChallenge, timingSafeEqual } from "../../shared/crypto";
import type { VerifiedClaims } from "../domain/idTokenClaims";
import { checkLineClaims } from "../domain/lineIdToken";

// Google／Apple／LINE の OpenID Connect（認可コードフロー）。外部とのやり取りはここに閉じ込める

export type OidcProviderName = "google" | "apple" | "line";

export class LoginFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type ProviderConfig = {
  authorizeEndpoint: (deps: AppDeps) => string;
  tokenEndpoint: (deps: AppDeps) => string;
  issuers: string[];
  clientId: (env: Bindings) => string;
  clientSecret: (env: Bindings, now: number) => Promise<string>;
  /** Apple は PKCE の対応が公式に確認できないため送らない（docs/specs/T-01-auth.md 決定事項9） */
  usePkce: boolean;
  authorizeParams: Record<string, string>;
};

const PROVIDERS: Record<OidcProviderName, ProviderConfig> = {
  google: {
    authorizeEndpoint: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: () => "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: async (env) => env.GOOGLE_CLIENT_SECRET,
    usePkce: true,
    authorizeParams: { scope: "openid email", prompt: "select_account" },
  },
  apple: {
    authorizeEndpoint: () => "https://appleid.apple.com/auth/authorize",
    tokenEndpoint: () => "https://appleid.apple.com/auth/token",
    issuers: ["https://appleid.apple.com"],
    clientId: (env) => env.APPLE_CLIENT_ID,
    clientSecret: appleClientSecret,
    usePkce: false,
    authorizeParams: { scope: "email", response_mode: "form_post" },
  },
  // LINE ログイン v2.1（通常のチャネル）。scope は openid だけ（名前・写真・メールアドレスは求めない。T-32 決めたこと2）
  line: {
    authorizeEndpoint: (deps) => deps.line.endpoints.authorize,
    tokenEndpoint: (deps) => deps.line.endpoints.token,
    issuers: ["https://access.line.me"],
    clientId: (env) => env.LINE_CHANNEL_ID ?? "",
    clientSecret: async (env) => env.LINE_CHANNEL_SECRET ?? "",
    usePkce: true,
    authorizeParams: { scope: "openid" },
  },
};

export const APPLE_AUDIENCE = "https://appleid.apple.com";

/** Apple のクライアントシークレット（ES256のJWT、5分） */
export async function appleClientSecret(env: Bindings, now: number): Promise<string> {
  const key = await importPKCS8(env.APPLE_PRIVATE_KEY, "ES256");
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_CLIENT_ID)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(key);
}

export function redirectUri(env: Bindings, provider: OidcProviderName): string {
  return `${env.APP_ORIGIN}/api/v1/auth/${provider}/callback`;
}

export async function authorizeUrl(
  env: Bindings,
  deps: AppDeps,
  provider: OidcProviderName,
  params: { state: string; nonce: string; codeVerifier: string },
): Promise<string> {
  const config = PROVIDERS[provider];
  const url = new URL(config.authorizeEndpoint(deps));
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId(env),
    redirect_uri: redirectUri(env, provider),
    state: params.state,
    nonce: params.nonce,
    ...config.authorizeParams,
    ...(config.usePkce
      ? { code_challenge: await pkceChallenge(params.codeVerifier), code_challenge_method: "S256" }
      : {}),
  }).toString();
  return url.toString();
}

/** 認可コードをIDトークンに交換し、署名・発行者・宛先・期限・nonceを検証したクレームを返す */
export async function exchangeCode(
  env: Bindings,
  deps: AppDeps,
  provider: OidcProviderName,
  params: { code: string; codeVerifier: string; nonce: string },
): Promise<VerifiedClaims> {
  const config = PROVIDERS[provider];
  const now = deps.now();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: redirectUri(env, provider),
    client_id: config.clientId(env),
    client_secret: await config.clientSecret(env, now),
    ...(config.usePkce ? { code_verifier: params.codeVerifier } : {}),
  });

  let res: Response;
  try {
    res = await deps.fetch(config.tokenEndpoint(deps), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
  } catch {
    throw new LoginFailed("token_endpoint_unreachable");
  }
  if (!res.ok) throw new LoginFailed("token_endpoint_error");

  const json: unknown = await res.json().catch(() => null);
  const idToken =
    json && typeof json === "object" && "id_token" in json && typeof json.id_token === "string"
      ? json.id_token
      : null;
  if (!idToken) throw new LoginFailed("id_token_missing");
  // IDトークンの確かめ方：Google・Apple はプロバイダの JWKS で署名（RS256）を確かめる。
  // LINE は verify のエンドポイントに署名を確かめてもらい、応答のクレームをこちらでも確かめる（docs/specs/T-32-line-login.md 決めたこと3）
  if (provider === "line") return verifyLineIdToken(env, deps, idToken, params.nonce, now);

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, deps.jwks[provider], {
      algorithms: ["RS256"],
      issuer: config.issuers,
      audience: config.clientId(env),
      clockTolerance: 60,
      currentDate: new Date(now),
      requiredClaims: ["sub", "exp", "iat", "nonce"],
    }));
  } catch {
    throw new LoginFailed("id_token_invalid");
  }

  if (typeof payload.nonce !== "string" || !timingSafeEqual(payload.nonce, params.nonce)) {
    throw new LoginFailed("nonce_mismatch");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 255) {
    throw new LoginFailed("sub_invalid");
  }
  return payload as VerifiedClaims;
}

/**
 * LINE の IDトークンを verify のエンドポイントで確かめる（docs/specs/T-32-line-login.md「振る舞い 4.」）。
 * LINE が署名・宛先・期限・nonce を確かめ、こちらでも応答の発行者・宛先・期限・nonce・sub を確かめる
 */
async function verifyLineIdToken(
  env: Bindings,
  deps: AppDeps,
  idToken: string,
  nonce: string,
  now: number,
): Promise<VerifiedClaims> {
  // 外へ送る前に長さを抑える（LINE の IDトークンは 1KB ほど）
  if (idToken.length > 8192) throw new LoginFailed("id_token_invalid");
  const channelId = PROVIDERS.line.clientId(env);
  let res: Response;
  try {
    res = await deps.fetch(deps.line.endpoints.verify, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId, nonce }),
    });
  } catch {
    throw new LoginFailed("verify_endpoint_unreachable");
  }
  // 400（署名・宛先・期限・nonce の不一致）も 5xx も、ログインの失敗にする
  if (!res.ok) throw new LoginFailed("id_token_invalid");
  const json: unknown = await res.json().catch(() => null);
  const checked = checkLineClaims(json, { channelId, now });
  if (!checked.ok) throw new LoginFailed(checked.reason);
  if (!timingSafeEqual(checked.claims.nonce, nonce)) throw new LoginFailed("nonce_mismatch");
  // メールアドレスは求めていないので、クレームに入っていても使わない（verifiedEmail が null を返す）
  return { sub: checked.claims.sub };
}
