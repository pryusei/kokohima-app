import { defaultDeps, problem } from "../app";
import { requireAuth } from "../identity/middleware";
import { createWorker } from "../worker";
import { e2eExpireBroadcast } from "./broadcasts";
import { E2E_CONTACT_WEBHOOK_TARGET, e2eContactPosts } from "./contact";
import { E2E_GOOGLE_ENDPOINTS, e2eCalendarAuthorize, e2eCalendarBusy, e2eCalendarSync, e2eFetch, e2eOutboxDrain } from "./calendar";
import { e2eLogin } from "./login";
import { E2E_LINK_PREVIEW_DEPS } from "./linkPreview";
import { E2E_NOTIFICATION_DEPS, e2eNotificationsSent } from "./notifications";

// E2E用のエントリ（wrangler の env.e2e でだけ使う）。本番のエントリからはimportしない
// Google・メール配信・プッシュへの fetch は偽の実装に向ける
// （docs/specs/T-06-calendar.md「E2E用の偽のGoogle」、docs/specs/T-07-notification.md「E2E用の偽のメール・プッシュ」、
// docs/specs/T-08-link-preview.md「E2E用の偽のサイト」、docs/specs/T-24-contact.md「8.」の偽の Slack）
const { app, handler } = createWorker({
  fetch: e2eFetch,
  google: { endpoints: E2E_GOOGLE_ENDPOINTS },
  notification: E2E_NOTIFICATION_DEPS,
  // 並んで走るテストが同じ回線になり、偽の埋まりを途中で変えるテストもあるので、上限とキャッシュを使わない（T-10）
  rateLimit: async () => true,
  cacheEnabled: false,
  // 偽のサイト（ogp.e2e.invalid）だけを許し、名前解決も偽物にする（T-08）
  linkPreview: E2E_LINK_PREVIEW_DEPS(defaultDeps().linkPreview),
  // 偽の Slack（slack.e2e.invalid）だけを許す。公開の日によらずに回す（T-24「振る舞い 11.」）
  contactWebhookTarget: E2E_CONTACT_WEBHOOK_TARGET,
  contactStartAt: 0,
});

app.use("/__e2e__/*", async (c, next) => {
  if (c.env.E2E_MODE !== "1") {
    return problem(c.get("requestId"), 404, "not_found", "Not Found");
  }
  await next();
});

app.post("/__e2e__/login", e2eLogin);
app.post("/__e2e__/broadcasts/:id/expire", requireAuth, e2eExpireBroadcast);
app.get("/__e2e__/calendar/google/authorize", e2eCalendarAuthorize);
app.post("/__e2e__/calendar/busy", requireAuth, e2eCalendarBusy);
app.post("/__e2e__/calendar/sync", requireAuth, e2eCalendarSync);
app.post("/__e2e__/outbox/drain", requireAuth, e2eOutboxDrain);
app.get("/__e2e__/notifications/sent", requireAuth, e2eNotificationsSent);
app.get("/__e2e__/contact/posts", requireAuth, e2eContactPosts);

/** テスト用：E2E のエントリのアプリ（経路の有効・無効を確かめる） */
export const e2eApp = app;

export default handler;
