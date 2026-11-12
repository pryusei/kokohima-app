import { rangeQuerySchema } from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { validationFailed } from "../http/validation";
import { requireActiveSession, requireAuth } from "../identity/middleware";
import { completeConnect, disconnectGoogle, getConnections, startConnect } from "./application/connections";
import { freeSlots } from "./application/freeSlots";
import { createIcsLink, icsFor } from "./application/ics";

// カレンダー連携のAPI（docs/specs/T-06-calendar.md「API」）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
const notFound = (c: Context<AppEnv>) => problem(c.get("requestId"), 404, "not_found", "Not Found");

const DAY_MS = 24 * 60 * 60 * 1000;
const FREE_SLOTS_MAX_DAYS = 14;

/** 結びつけCookie（T-01 の __Host-kh_oauth とは別の名前。ログインと同時に進めても壊さない） */
const BINDING = "kh_cal";
const getBinding = (c: Context<AppEnv>) => getCookie(c, BINDING, "host");
const clearBinding = (c: Context<AppEnv>) => deleteCookie(c, BINDING, { prefix: "host", path: "/", secure: true });
const setBinding = (c: Context<AppEnv>, value: string) =>
  setCookie(c, BINDING, value, { prefix: "host", path: "/", secure: true, httpOnly: true, sameSite: "Lax", maxAge: 600 });

/** .ics のトークン（randomToken の base64url） */
const icsToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function calendarRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/calendar/google/authorizations", requireAuth, requireActiveSession, async (c) => {
    const result = await startConnect(ctx(c), c.var.viewer.userId);
    if (result.kind === "rate_limited") {
      const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
      res.headers.set("Retry-After", String(result.retryAfterSeconds));
      return res;
    }
    setBinding(c, result.binding);
    return c.json({ authorizeUrl: result.authorizeUrl });
  });

  // Google からのリダイレクト。成功も失敗も303で画面へ戻す（失敗の理由は区別しない）
  app.get("/calendar/google/callback", async (c) => {
    const q = c.req.query();
    let ok = false;
    try {
      ok = await completeConnect(ctx(c), { code: q.code, state: q.state, error: q.error, binding: getBinding(c) });
    } catch (e) {
      // 想定外の失敗も、ほかの失敗と同じ ?calendar=failed にする（常に303）
      console.error(JSON.stringify({ event: "calendar_connect_failed", reason: "unexpected", name: e instanceof Error ? e.name : "unknown" }));
    }
    clearBinding(c);
    return c.redirect(`${c.env.APP_ORIGIN}/settings/calendar?calendar=${ok ? "connected" : "failed"}`, 303);
  });

  app.get("/calendar/connections", requireAuth, async (c) => c.json(await getConnections(ctx(c), c.var.viewer.userId)));

  app.delete("/calendar/connections/google", requireAuth, requireActiveSession, async (c) => {
    const ok = await disconnectGoogle(ctx(c), c.var.viewer.userId);
    return ok ? c.body(null, 204) : notFound(c);
  });

  app.get("/calendar/free-slots", requireAuth, async (c) => {
    const q = rangeQuerySchema.safeParse(c.req.query());
    if (!q.success) return validationFailed(c, q.error);
    const from = Date.parse(q.data.from);
    const to = Date.parse(q.data.to);
    if (to - from > FREE_SLOTS_MAX_DAYS * DAY_MS) return validationFailed(c, null);
    return c.json(await freeSlots(ctx(c), c.var.viewer.userId, from, to));
  });

  app.post("/meetups/:id/ics-links", requireAuth, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const link = await createIcsLink(ctx(c), c.var.viewer.userId, id.data);
    return link ? c.json(link) : notFound(c);
  });

  // 認証なし（URL のトークン）。OS のカレンダーへの追加に画面遷移で開かせるため（決定事項10・14）
  app.get("/ics/:token", async (c) => {
    const token = icsToken.safeParse(c.req.param("token"));
    if (!token.success) return notFound(c);
    const ics = await icsFor(ctx(c), token.data);
    if (!ics) return notFound(c);
    return c.body(ics.body, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="kokohima-${ics.meetupId}.ics"`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
  });

  return app;
}
