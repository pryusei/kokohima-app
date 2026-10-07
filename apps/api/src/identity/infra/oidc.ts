import { importPKCS8, jwtVerify, SignJWT } from "jose";
import type { AppDeps, Bindings } from "../../env";
import { pkceChallenge, timingSafeEqual } from "../../shared/crypto";
import type { VerifiedClaims } from "../domain/idTokenClaims";

// Google／Apple の OpenID Connect（認可コードフロー）。外部とのやり取りはここに閉じ込める

export type OidcProviderName = "google" | "apple";

export class LoginFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type ProviderConfig = {
  authorizeEndpoint: string;
  tokenEndpoint: string;
  issuers: string[];
  clientId: (env: Bindings) => string;
  clientSecret: (env: Bindings, now: number) => Promise<string>;
  /** Apple は PKCE の対応が公式に確認できないため送らない（docs/specs/T-01-auth.md 決定事項9） */
  usePkce: boolean;
  authorizeParams: Record<string, string>;
};

const PROVIDERS: Record<OidcProviderName, ProviderConfig> = {
  google: {
    authorizeEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: async (env) => env.GOOGLE_CLIENT_SECRET,
    usePkce: true,
    authorizeParams: { scope: "openid email", prompt: "select_account" },
  },
  apple: {
    authorizeEndpoint: "https://appleid.apple.com/auth/authorize",
    tokenEndpoint: "https://appleid.apple.com/auth/token",
    issuers: ["https://appleid.apple.com"],
    clientId: (env) => env.APPLE_CLIENT_ID,
    clientSecret: appleClientSecret,
    usePkce: false,
    authorizeParams: { scope: "email", response_mode: "form_post" },
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
  provider: OidcProviderName,
  params: { state: string; nonce: string; codeVerifier: string },
): Promise<string> {
  const config = PROVIDERS[provider];
  const url = new URL(config.authorizeEndpoint);
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
    res = await deps.fetch(config.tokenEndpoint, {
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
