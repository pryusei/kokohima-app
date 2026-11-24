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
  /** メール配信（Resend）の API キー（secret） */
  RESEND_API_KEY: string;
  /** VAPID の秘密鍵（P-256、PKCS#8 の PEM。secret）と公開鍵（base64url、非圧縮の点） */
  VAPID_PRIVATE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  /** プッシュの購読の endpoint の暗号化の鍵（kid → 32バイトのbase64 の JSON。secret） */
  NOTIFICATION_KEYS: string;
  NOTIFICATION_CURRENT_KID: string;
  MAIL_FROM: string;
  /** T-07 を有効にした時刻（Unixミリ秒の文字列）。これより前の通知だけの型の outbox の行は送らない */
  NOTIFICATION_START_AT: string;
  /** サービス全体の1日のメール数の上限（文字列の整数） */
  MAIL_DAILY_LIMIT: string;
  /** 外部の結果のキャッシュ（docs/specs/T-10-idempotency-cache-ratelimit.md） */
  CACHE?: KVNamespace;
  /** おおよその回数の上限（Rate Limiting）。認証なしの経路は IP、認証のある経路は利用者 ID をキーにする */
  RL_PUBLIC?: RateLimit;
  RL_USER?: RateLimit;
  /** リンクのプレビューの画像（R2。docs/specs/T-08-link-preview.md） */
  OGP_IMAGES: R2Bucket;
  /** アイコンの画像（R2。docs/specs/T-27-avatar-upload.md） */
  AVATARS: R2Bucket;
  /** アイコンの画像の URL の署名の鍵（32バイトの base64url。secret。T-27「署名」） */
  AVATAR_URL_KEY: string;
  /** アプリ自身の登録ドメイン（カンマ区切りの小文字のホスト名）。このドメインとそのサブドメインは取りに行かない */
  LINK_PREVIEW_OWN_DOMAINS: string;
  /** Sign in with Apple を動かすか（"1" のときだけ。docs/specs/T-12-release.md） */
  APPLE_LOGIN_ENABLED?: string;
  /** 画面（apps/web のビルド）の静的アセット。prod と、ローカル専用の assets の環境にだけある（docs/specs/T-12-release.md「振り分け」） */
  ASSETS?: Fetcher;
  /** 問い合わせを届ける Slack の Incoming Webhook の URL（secret。docs/specs/T-24-contact.md「8.」）。ないと consumer は送らずに失敗する */
  CONTACT_SLACK_WEBHOOK_URL?: string;
  /** 行きたいのAI提案の Claude API のキー（secret。docs/specs/T-29-wish-suggestion.md「設定値」）。ないと機能を止める */
  ANTHROPIC_API_KEY?: string;
  /** モデルの ID（既定 claude-haiku-5-5）と回数の上限（既定 5・10・100）。省略できる */
  WISH_SUGGEST_MODEL?: string;
  WISH_SUGGEST_USER_DAILY_LIMIT?: string;
  WISH_SUGGEST_USER_DAILY_ATTEMPTS?: string;
  WISH_SUGGEST_GLOBAL_DAILY_LIMIT?: string;
  E2E_MODE?: string;
};

export type RateLimiterName = "RL_PUBLIC" | "RL_USER";

export type JobMessage =
  /** createdAt は outbox の行を作った時刻（T-07 の「古い outbox の行」の線引きに使う） */
  | { kind: "outbox"; id: string; type: string; payload: string; createdAt?: number }
  | { kind: "calendar_sync"; userId: string; provider: "google" }
  | { kind: "notification_deliver"; notificationId: string };

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
  notification: {
    /** メール配信の送信先 */
    resendUrl: string;
    /** プッシュの endpoint として追加で許可するホスト（E2E の偽のホストだけ。本番は空） */
    extraPushHosts: readonly string[];
  };
  /** 回数の上限の判定（T-10）。E2E では上限を実質なしにする */
  rateLimit: (env: Bindings, limiter: RateLimiterName, key: string) => Promise<boolean>;
  /** KV のキャッシュを使うか（E2E では使わない） */
  cacheEnabled: boolean;
  linkPreview: {
    /** 名前解決（DNS over HTTPS）。E2E だけ偽物に差し替える */
    resolve: (deps: AppDeps, host: string) => Promise<ResolveResult>;
    /** 取りに行ってよい URL の判定で追加で許すホスト（E2E の偽のサイトだけ。本番は空） */
    extraHosts: readonly string[];
    /** タイムアウト（ミリ秒）。1回の取得（本文を読み終えるまで）・ページか画像の全体・名前解決の1回。テストでだけ短くする */
    timeouts: { fetchMs: number; totalMs: number; dnsMs: number };
  };
  /**
   * 問い合わせの webhook の許す宛先（T-24「振る舞い 3.」）。既定は hooks.slack.com の /services/。
   * 差し替えるのは E2E のエントリ（src/e2e/entry.ts）だけ（環境変数では切り替えない）
   */
  contactWebhookTarget: ContactWebhookTarget;
  /** 問い合わせの公開の日（Unix ミリ秒。null は未定）。既定は packages/shared の contactStartAt()。E2E のエントリだけが 0 にする */
  contactStartAt: number | null;
  /** ブロックと通報を始める日（Unix ミリ秒。null は未定。T-33「振る舞い 8.」）。既定は packages/shared の safetyStartAt()。E2E のエントリだけが 0 にする */
  safetyStartAt: number | null;
  /** 行きたいのAI提案（T-29）。全体の時間の上限（ミリ秒）。テストでだけ短くする */
  wishSuggest: { timeoutMs: number };
};

export type ContactWebhookTarget = { hostname: string; pathPrefix: string };

/** 名前解決の結果。addresses は A・AAAA の data。not_found は NXDOMAIN、error は SERVFAIL・タイムアウトなど */
export type ResolveResult =
  | { kind: "ok"; addresses: string[] }
  | { kind: "not_found" }
  | { kind: "error" };

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
