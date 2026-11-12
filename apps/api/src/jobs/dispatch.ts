import type { AppDeps, Bindings } from "../env";
import { deleteExpiredIcsTokens, deleteExpiredOauthStates } from "../calendar/infra/repository";
import { OAUTH_STATE_TTL_MS } from "../calendar/application/connections";

// outbox を Queues に流す（docs/specs/T-06-calendar.md「outbox を Queues に流す」）
// 送ってから処理済みにする。途中で止まっても行は未処理のまま残り、次の実行で送り直す（少なくとも1回は届く）

type Ctx = { env: Bindings; deps: AppDeps };

/** この仕様書で処理する型。ほかの型（通知の対象）は取り出さず、T-07 で足す */
export const DISPATCHED_TYPES = [
  "MeetupConfirmed",
  "MeetupCancelled",
  "MeetupLeft",
  "CalendarConnected",
  "AvailabilityCancelledByCalendar",
] as const;

export const DISPATCH_BATCH = 100;

export async function dispatchOutbox(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, type, payload FROM outbox
     WHERE processed_at IS NULL AND type IN (SELECT value FROM json_each(?1))
     ORDER BY created_at, id LIMIT ?2`,
  )
    .bind(JSON.stringify(DISPATCHED_TYPES), DISPATCH_BATCH)
    .all<{ id: string; type: string; payload: string }>();
  if (results.length === 0) return 0;
  await ctx.env.JOBS.sendBatch(
    results.map((r) => ({ body: { kind: "outbox" as const, id: r.id, type: r.type, payload: r.payload } })),
  );
  await ctx.env.DB.prepare(
    "UPDATE outbox SET processed_at = ?1 WHERE processed_at IS NULL AND id IN (SELECT value FROM json_each(?2))",
  )
    .bind(ctx.deps.now(), JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}

/** 期限を過ぎた連携の state と .ics のトークンを消す */
export async function cleanupExpired(ctx: Ctx) {
  const now = ctx.deps.now();
  await deleteExpiredOauthStates(ctx.env.DB, now - OAUTH_STATE_TTL_MS);
  await deleteExpiredIcsTokens(ctx.env.DB, now);
}
