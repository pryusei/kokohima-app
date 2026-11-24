import { calendarAuthorizationRequestSchema, rangeQuerySchema } from "@kokohima/shared";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import * as z from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { rateLimit, rateLimitedProblem } from "../http/rateLimit";
import { validationFailed } from "../http/validation";
import { requireActiveSession, requireAuth } from "../identity/middleware";
import { completeConnect, disconnectGoogle, getConnections, SETTINGS_RETURN_PATH, startConnect } from "./application/connections";
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

/** 連携の開始の本文（任意）。本文なし・空の本文は {} と同じ。JSON でなければ null（400） */
async function authorizationBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** .ics のトークン（randomToken の base64url） */
const icsToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function calendarRoutes() {
  const app = new Hono<AppEnv>();

  app.post("/calendar/google/authorizations", requireAuth, requireActiveSession, async (c) => {
    // 予定の ID は戻り先だけに使う（docs/specs/T-57-meetup-google-calendar.md「入力」）。検証に通らなければ行を足さない
    const body = calendarAuthorizationRequestSchema.safeParse(await authorizationBody(c));
    if (!body.success) return validationFailed(c, body.error);
    const result = await startConnect(ctx(c), c.var.viewer.userId, body.data.meetupId ?? null);
    if (result.kind === "rate_limited") {
      const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
      res.headers.set("Retry-After", String(result.retryAfterSeconds));
      return res;
    }
    setBinding(c, result.binding);
    return c.json({ authorizeUrl: result.authorizeUrl });
  });

  // Google からのリダイレクト。成功も失敗も303で画面へ戻す（失敗の理由は区別しない）。
  // 戻り先は state の行に保存した予定の ID から組み立てるパスだけ（外から URL を受け取らない。T-57「戻り先」）
  app.get("/calendar/google/callback", async (c) => {
    const q = c.req.query();
    let result = { connected: false, returnPath: SETTINGS_RETURN_PATH };
    try {
      result = await completeConnect(ctx(c), { code: q.code, state: q.state, error: q.error, binding: getBinding(c) });
    } catch (e) {
      // state の行を取り出す前の想定外の失敗。戻り先を知れないので設定へ（常に303）
      console.error(JSON.stringify({ event: "calendar_connect_failed", reason: "unexpected", name: e instanceof Error ? e.name : "unknown" }));
    }
    clearBinding(c);
    return c.redirect(`${c.env.APP_ORIGIN}${result.returnPath}?calendar=${result.connected ? "connected" : "failed"}`, 303);
  });

  app.get("/calendar/connections", requireAuth, async (c) => c.json(await getConnections(ctx(c), c.var.viewer.userId)));

  app.delete("/calendar/connections/google", requireAuth, requireActiveSession, async (c) => {
    const ok = await disconnectGoogle(ctx(c), c.var.viewer.userId);
    return ok ? c.body(null, 204) : notFound(c);
  });

  app.get("/calendar/free-slots", requireAuth, rateLimit({ group: "free_slots", limiter: "RL_USER", by: "user" }), async (c) => {
    const q = rangeQuerySchema.safeParse(c.req.query());
    if (!q.success) return validationFailed(c, q.error);
    const from = Date.parse(q.data.from);
    const to = Date.parse(q.data.to);
    if (to - from > FREE_SLOTS_MAX_DAYS * DAY_MS) return validationFailed(c, null);
    return c.json(await freeSlots(ctx(c), c.var.viewer.userId, from, to));
  });

  app.post("/meetups/:id/ics-links", requireAuth, requireActiveSession, async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return notFound(c);
    const link = await createIcsLink(ctx(c), c.var.viewer.userId, id.data);
    if (link.kind === "not_found") return notFound(c);
    if (link.kind === "rate_limited") {
      const res = rateLimitedProblem(c);
      res.headers.set("Retry-After", String(link.retryAfterSeconds));
      return res;
    }
    return c.json(link.link);
  });

  // 認証なし（URL のトークン）。OS のカレンダーへの追加に画面遷移で開かせるため（決定事項10・14）
  app.get(
    "/ics/:token",
    // OS のカレンダーが開く経路なので、上限を超えたら本文なしの429
    rateLimit({
      group: "ics",
      limiter: "RL_PUBLIC",
      by: "ip",
      onLimited: () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    }),
    async (c) => {
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
