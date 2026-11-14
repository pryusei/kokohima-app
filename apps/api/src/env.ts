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
  /** カレンダーの更新用トークンの暗号化の鍵（kid → 32バイトのbase64 の JSON。secret） */
  CALENDAR_TOKEN_KEYS: string;
  CALENDAR_TOKEN_CURRENT_KID: string;
  /** outbox と定期の確認のメッセージ（docs/specs/T-06-calendar.md「outbox を Queues に流す」） */
  JOBS: Queue<JobMessage>;
  E2E_MODE?: string;
};

export type JobMessage =
  | { kind: "outbox"; id: string; type: string; payload: string }
  | { kind: "calendar_sync"; userId: string; provider: "google" };

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
  google: { endpoints: GoogleEndpoints };
};

/** Google の各エンドポイント。E2E では偽の経路に向ける（docs/specs/T-06-calendar.md「E2E用の偽のGoogle」） */
export type GoogleEndpoints = {
  /** 利用者のブラウザが画面遷移する認可の画面 */
  authorize: string;
  token: string;
  revoke: string;
  /** Calendar API の基点（末尾の / なし） */
  calendar: string;
};

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  calendar: "https://www.googleapis.com/calendar/v3",
};
