import {
  listQuerySchema,
  markReadRequestSchema,
  notificationPreferencesPatchSchema,
  pushSubscriptionRequestSchema,
  pushUnsubscribeRequestSchema,
} from "@kokohima/shared";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { validationFailed } from "../http/validation";
import { requireActiveSessionForWrites, requireAuth } from "../identity/middleware";
import { decodeCursor, encodeCursor } from "../shared/cursor";
import * as notifications from "./application/notifications";
import { subscribe, unsubscribe } from "./application/subscriptions";

// 通知のAPI（docs/specs/T-07-notification.md「API」）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const json = (c: Context<AppEnv>) => c.req.json().catch(() => null);

export function notificationRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/notifications", requireAuth, requireActiveSessionForWrites);
  app.use("/notifications/*", requireAuth, requireActiveSessionForWrites);
  app.use("/me/notification-preferences", requireAuth, requireActiveSessionForWrites);
  app.use("/push/*", requireAuth, requireActiveSessionForWrites);

  app.get("/notifications", async (c) => {
    const q = listQuerySchema.safeParse(c.req.query());
    if (!q.success) return validationFailed(c, q.error);
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
    if (q.data.cursor !== undefined && !cursor) return validationFailed(c, null);
    const result = await notifications.listNotifications(ctx(c), c.var.viewer.userId, q.data.limit, cursor);
    return c.json({ items: result.items, nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null });
  });

  app.get("/notifications/unread-count", async (c) =>
    c.json({ count: await notifications.unreadCount(ctx(c), c.var.viewer.userId) }),
  );

  app.post("/notifications/read", async (c) => {
    const body = markReadRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const ok = await notifications.markRead(ctx(c), c.var.viewer.userId, body.data.upTo);
    return ok ? c.body(null, 204) : validationFailed(c, null);
  });

  app.get("/me/notification-preferences", async (c) =>
    c.json(await notifications.getPreferences(ctx(c), c.var.viewer.userId)),
  );

  app.patch("/me/notification-preferences", async (c) => {
    const body = notificationPreferencesPatchSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    return c.json(await notifications.patchPreferences(ctx(c), c.var.viewer.userId, body.data));
  });

  app.get("/push/vapid-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }));

  // 失効したセッションでは登録させない（その端末に、お知らせの合図を届けないため）
  app.post("/push/subscriptions", async (c) => {
    const body = pushSubscriptionRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    const ok = await subscribe(ctx(c), c.var.viewer, body.data.endpoint, body.data.keys ?? null);
    return ok ? c.body(null, 204) : validationFailed(c, null);
  });

  // 購読がなくても204（ほかの人の購読があるかを推測させない）
  app.delete("/push/subscriptions", async (c) => {
    const body = pushUnsubscribeRequestSchema.safeParse(await json(c));
    if (!body.success) return validationFailed(c, body.error);
    await unsubscribe(ctx(c), c.var.viewer.userId, body.data.endpoint);
    return c.body(null, 204);
  });

  return app;
}
