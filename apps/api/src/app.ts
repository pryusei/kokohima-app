import { contactStartAt } from "@kokohima/shared";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { createRemoteJWKSet } from "jose";
import { GOOGLE_ENDPOINTS, type AppDeps, type AppEnv } from "./env";
import { healthReady } from "./http/health";
import { problem } from "./http/problem";
import { rateLimit } from "./http/rateLimit";
import { availabilityRoutes } from "./availability/routes";
import { calendarRoutes } from "./calendar/routes";
import { CONTACT_WEBHOOK_TARGET } from "./contact/domain/webhook";
import { contactRoutes } from "./contact/routes";
import { identityRoutes } from "./identity/routes";
import { avatarRoutes } from "./identity/avatarRoutes";
import { invitationRoutes } from "./invitation/routes";
import { resolveDoh } from "./link-preview/infra/dns";
import { linkPreviewRoutes } from "./link-preview/routes";
import { notificationRoutes } from "./notification/routes";
import { socialRoutes } from "./social/routes";
import { SUGGEST_TIMEOUT_MS } from "./wish/domain/suggestion";
import { wishRoutes } from "./wish/routes";

export { problem };

export function defaultDeps(): AppDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    jwks: {
      google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
      apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
    },
    now: () => Date.now(),
    google: { endpoints: GOOGLE_ENDPOINTS },
    notification: { resendUrl: "https://api.resend.com/emails", extraPushHosts: [] },
    // バインディングがない（設定の漏れ）・判定に失敗したときは、記録を残して通す。おおよその上限なので、止めるより通す側に倒す
    // 記録にはキー（IP・利用者 ID）を入れない
    rateLimit: async (env, limiter, key) => {
      const binding = env[limiter];
      if (!binding) {
        console.log(JSON.stringify({ event: "rate_limit_skipped", limiter, reason: "no_binding" }));
        return true;
      }
      try {
        return (await binding.limit({ key })).success;
      } catch (e) {
        console.log(JSON.stringify({ event: "rate_limit_skipped", limiter, reason: "error", name: (e as Error).name }));
        return true;
      }
    },
    cacheEnabled: true,
    linkPreview: { resolve: resolveDoh, extraHosts: [], timeouts: { fetchMs: 5000, totalMs: 10_000, dnsMs: 3000 } },
    // 問い合わせ（docs/specs/T-24-contact.md）。差し替えるのは E2E のエントリだけ
    contactWebhookTarget: CONTACT_WEBHOOK_TARGET,
    contactStartAt: contactStartAt(),
    wishSuggest: { timeoutMs: SUGGEST_TIMEOUT_MS },
  };
}

// 本番とE2Eで共有するアプリ本体。E2E用の経路はここに足さない（src/e2e/entry.ts で足す）
export function createApp(overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));
  // 深い死活確認（D1 を読むので IP ごとに回数の上限をかける。docs/specs/T-13-monitoring.md）
  app.get("/api/v1/health/ready", rateLimit({ group: "health_ready", limiter: "RL_PUBLIC", by: "ip" }), healthReady);
  app.route("/api/v1", identityRoutes());
  app.route("/api/v1", avatarRoutes());
  app.route("/api/v1", socialRoutes());
  app.route("/api/v1", availabilityRoutes());
  app.route("/api/v1", invitationRoutes());
  app.route("/api/v1", wishRoutes());
  app.route("/api/v1", calendarRoutes());
  app.route("/api/v1", notificationRoutes());
  app.route("/api/v1", linkPreviewRoutes());
  app.route("/api/v1", contactRoutes());

  app.notFound((c) => problem(c.get("requestId"), 404, "not_found", "Not Found"));

  // 例外の中身（スタックトレースや内部の値）はレスポンスにもログにも出さない
  app.onError((err, c) => {
    console.error(JSON.stringify({ event: "unhandled_error", requestId: c.get("requestId"), name: err.name }));
    return problem(c.get("requestId"), 500, "internal_error", "Internal Server Error");
  });

  return app;
}

