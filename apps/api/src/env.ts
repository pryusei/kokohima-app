import type { JWTVerifyGetKey } from "jose";

// Workers のバインディングと設定値（docs/specs/T-01-auth.md「設定値」）
export type Bindings = {
  DB: D1Database;
  APP_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  APPLE_CLIENT_ID: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  JWT_SIGNING_KEYS: string;
  JWT_CURRENT_KID: string;
  E2E_MODE?: string;
};

export type Viewer = { userId: string; sessionId: string };

export type AppEnv = {
  Bindings: Bindings;
  Variables: { requestId: string; viewer: Viewer; deps: AppDeps };
};

/** テストで差し替える外部への依存 */
export type AppDeps = {
  fetch: typeof fetch;
  jwks: { google: JWTVerifyGetKey; apple: JWTVerifyGetKey };
  now: () => number;
};
