import { problem } from "../app";
import { requireAuth } from "../identity/middleware";
import { createWorker } from "../worker";
import { e2eExpireBroadcast } from "./broadcasts";
import { E2E_GOOGLE_ENDPOINTS, e2eCalendarAuthorize, e2eCalendarBusy, e2eCalendarSync, e2eFetch, e2eOutboxDrain } from "./calendar";
import { e2eLogin } from "./login";

// E2E用のエントリ（wrangler の env.e2e でだけ使う）。本番のエントリからはimportしない
// Google への fetch は偽の実装に向ける（docs/specs/T-06-calendar.md「E2E用の偽のGoogle」）
const { app, handler } = createWorker({ fetch: e2eFetch, google: { endpoints: E2E_GOOGLE_ENDPOINTS } });

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

/** テスト用：E2E のエントリのアプリ（経路の有効・無効を確かめる） */
export const e2eApp = app;

export default handler;
