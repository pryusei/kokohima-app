import { env } from "cloudflare:workers";
import type { Context } from "hono";
import { z } from "zod";
import { syncConnection } from "../calendar/application/sync";
import type { AppEnv, GoogleEndpoints } from "../env";
import { problem } from "../http/problem";
import { handleJob } from "../jobs/consumer";
import { DISPATCHED_TYPES } from "../jobs/dispatch";
import { sha256 } from "../shared/crypto";

// E2E用の偽の Google（docs/specs/T-06-calendar.md「E2E用の偽のGoogle」）。src/e2e/entry.ts からだけ読み込む
// 状態はこのファイルだけが作る表に置く（本番のマイグレーションには入れない）

const FAKE_HOST = "google.e2e.invalid";

export const E2E_GOOGLE_ENDPOINTS: GoogleEndpoints = {
  // 利用者のブラウザが画面遷移する先。API（wrangler dev --env e2e）の偽の認可画面
  authorize: "http://localhost:8787/__e2e__/calendar/google/authorize",
  token: `https://${FAKE_HOST}/token`,
  revoke: `https://${FAKE_HOST}/revoke`,
  calendar: `https://${FAKE_HOST}/calendar/v3`,
};

async function ensureTables() {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS e2e_fake_busy (user_id TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL)"),
  ]);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** 偽の Google の API。アクセストークンは `e2e-access-<userId>`、更新用トークンは `e2e-refresh-<userId>` */
async function fakeGoogle(url: URL, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
  if (url.pathname === "/token") {
    const form = new URLSearchParams(body);
    if (form.get("grant_type") === "authorization_code") {
      const userId = (form.get("code") ?? "").replace(/^e2e-code-/, "");
      return json({
        access_token: `e2e-access-${userId}`,
        refresh_token: `e2e-refresh-${userId}`,
        scope: "https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.app.created",
      });
    }
    const userId = (form.get("refresh_token") ?? "").replace(/^e2e-refresh-/, "");
    return json({ access_token: `e2e-access-${userId}` });
  }
  if (url.pathname === "/revoke") return new Response(null, { status: 200 });

  const userId = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer e2e-access-/, "");
  if (url.pathname === "/calendar/v3/freeBusy" && method === "POST") {
    await ensureTables();
    const { results } = await env.DB.prepare("SELECT starts_at, ends_at FROM e2e_fake_busy WHERE user_id = ?1")
      .bind(userId)
      .all<{ starts_at: number; ends_at: number }>();
    const busy = results.map((r) => ({ start: new Date(r.starts_at).toISOString(), end: new Date(r.ends_at).toISOString() }));
    return json({ calendars: { primary: { busy } } });
  }
  if (url.pathname === "/calendar/v3/calendars" && method === "POST") return json({ id: `e2e-cal-${userId}` });
  // 予定の作成・更新・削除とカレンダーの削除は受け付けるだけ（E2E では .ics で確かめる）
  if (url.pathname.startsWith("/calendar/v3/calendars/")) return method === "DELETE" ? new Response(null, { status: 204 }) : json({});
  return json({}, 404);
}

/** E2E のエントリの fetch。偽の Google の宛先だけをここで受ける */
export const e2eFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  if (url.host === FAKE_HOST) return fakeGoogle(url, init);
  return fetch(input, init);
};

const notFound = (c: Context<AppEnv>) => problem(c.get("requestId"), 404, "not_found", "Not Found");

/** 偽の認可画面：同意したことにして、コールバックへ戻す。利用者は state から引く */
export async function e2eCalendarAuthorize(c: Context<AppEnv>) {
  const state = c.req.query("state") ?? "";
  const redirectUri = c.req.query("redirect_uri") ?? "";
  if (!redirectUri.startsWith(`${c.env.APP_ORIGIN}/`)) return notFound(c);
  const row = await c.env.DB.prepare("SELECT user_id FROM calendar_oauth_states WHERE state_hash = ?1")
    .bind(await sha256(state))
    .first<{ user_id: string }>();
  if (!row) return notFound(c);
  const back = new URL(redirectUri);
  back.searchParams.set("code", `e2e-code-${row.user_id}`);
  back.searchParams.set("state", state);
  return c.redirect(back.toString(), 302);
}

const busySchema = z.object({
  busy: z.array(z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })).max(50),
});

/** 閲覧者の偽の埋まりを置き換える */
export async function e2eCalendarBusy(c: Context<AppEnv>) {
  const parsed = busySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c.get("requestId"), 400, "validation_failed", "Validation failed");
  await ensureTables();
  const userId = c.var.viewer.userId;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM e2e_fake_busy WHERE user_id = ?1").bind(userId),
    ...parsed.data.busy.map((b) =>
      c.env.DB.prepare("INSERT INTO e2e_fake_busy (user_id, starts_at, ends_at) VALUES (?1, ?2, ?3)").bind(
        userId,
        Date.parse(b.startsAt),
        Date.parse(b.endsAt),
      ),
    ),
  ]);
  return c.body(null, 204);
}

/** 閲覧者の定期の確認をすぐに行う */
export async function e2eCalendarSync(c: Context<AppEnv>) {
  const outcome = await syncConnection({ env: c.env, deps: c.var.deps }, c.var.viewer.userId, "google");
  return c.json({ outcome });
}

/** outbox のうち、この仕様書で処理する型の未処理の行を、Queue を通さずにすぐ処理する */
export async function e2eOutboxDrain(c: Context<AppEnv>) {
  const ctx = { env: c.env, deps: c.var.deps };
  const { results } = await c.env.DB.prepare(
    `SELECT id, type, payload FROM outbox
     WHERE processed_at IS NULL AND type IN (SELECT value FROM json_each(?1)) ORDER BY created_at, id LIMIT 200`,
  )
    .bind(JSON.stringify(DISPATCHED_TYPES))
    .all<{ id: string; type: string; payload: string }>();
  for (const r of results) {
    await handleJob(ctx, { kind: "outbox", id: r.id, type: r.type, payload: r.payload });
    await c.env.DB.prepare("UPDATE outbox SET processed_at = ?1 WHERE id = ?2").bind(ctx.deps.now(), r.id).run();
  }
  return c.json({ processed: results.length });
}
