import type { AppDeps, Bindings } from "../env";
import { deleteExpiredIcsTokens, deleteExpiredOauthStates } from "../calendar/infra/repository";
import { OAUTH_STATE_TTL_MS } from "../calendar/application/connections";
import { cleanupNotifications, notificationStartAt } from "../notification/application/delivery";
import { NOTIFICATION_ONLY_TYPES } from "../notification/domain/events";

// outbox を Queues に流す（docs/specs/T-06-calendar.md「outbox を Queues に流す」）
// 送ってから処理済みにする。途中で止まっても行は未処理のまま残り、次の実行で送り直す（少なくとも1回は届く）

type Ctx = { env: Bindings; deps: AppDeps };

/** T-06 の型。カレンダーの書き込みや自動の「今回は難しい」も動かすので、常に流す */
export const CALENDAR_TYPES = [
  "MeetupConfirmed",
  "MeetupCancelled",
  "MeetupLeft",
  "CalendarConnected",
  "AvailabilityCancelledByCalendar",
] as const;

/** 取り出す型（T-06 の型と、T-07 の通知だけの型） */
export const DISPATCHED_TYPES = [...CALENDAR_TYPES, ...NOTIFICATION_ONLY_TYPES] as const;

export const DISPATCH_BATCH = 100;

/**
 * 通知だけの型のうち、T-07 を有効にした時刻より前に作られた行は、送らずに処理済みにする
 * （docs/specs/T-07-notification.md「古い outbox の行」決定事項5）
 */
async function skipOldNotificationRows(ctx: Ctx) {
  await ctx.env.DB.prepare(
    `UPDATE outbox SET processed_at = ?1
     WHERE processed_at IS NULL AND created_at < ?2 AND type IN (SELECT value FROM json_each(?3))`,
  )
    .bind(ctx.deps.now(), notificationStartAt(ctx.env), JSON.stringify(NOTIFICATION_ONLY_TYPES))
    .run();
}

export async function dispatchOutbox(ctx: Ctx) {
  await skipOldNotificationRows(ctx);
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

/** 期限を過ぎた連携の state と .ics のトークン、古いお知らせと日ごとの数を消す */
export async function cleanupExpired(ctx: Ctx) {
  const now = ctx.deps.now();
  await deleteExpiredOauthStates(ctx.env.DB, now - OAUTH_STATE_TTL_MS);
  await deleteExpiredIcsTokens(ctx.env.DB, now);
  await cleanupNotifications(ctx);
}
