import type { AppDeps, Bindings } from "../env";
import { deleteExpiredIcsTokens, deleteExpiredOauthStates } from "../calendar/infra/repository";
import { db as identityDb, deleteExpiredLoginRecords } from "../identity/infra/repository";
import { OAUTH_STATE_TTL_MS } from "../calendar/application/connections";
import { cleanupNotifications, notificationStartAt } from "../notification/application/delivery";
import { NOTIFICATION_ONLY_TYPES } from "../notification/domain/events";
import { deleteExpiredIdempotencyKeys } from "../shared/idempotency";
import { cleanupLinkPreviews } from "../link-preview/application/previews";

// outbox を Queues に流す（docs/specs/T-06-calendar.md「outbox を Queues に流す」）
// 送ってから処理済みにする。途中で止まっても行は未処理のまま残り、次の実行で送り直す（少なくとも1回は届く）

type Ctx = { env: Bindings; deps: AppDeps };

/**
 * 常に流す型（NOTIFICATION_START_AT に左右されない）。T-06 の型はカレンダーの書き込みや自動の「今回は難しい」を、
 * LinkAttached（T-08）はリンクのプレビューの取得を動かす
 */
export const CALENDAR_TYPES = [
  "MeetupConfirmed",
  "MeetupCancelled",
  "MeetupLeft",
  "CalendarConnected",
  "AvailabilityCancelledByCalendar",
  "LinkAttached",
] as const;

/** 取り出す型（T-06 の型と、T-07 の通知だけの型） */
export const DISPATCHED_TYPES = [...CALENDAR_TYPES, ...NOTIFICATION_ONLY_TYPES] as const;

/**
 * いま取り出す型。`NOTIFICATION_START_AT` が未設定なら、通知だけの型は流さず、処理済みにもしない
 * （設定したあとで、その時刻より後の行から流れる）
 */
export const dispatchedTypes = (env: Bindings): readonly string[] =>
  notificationStartAt(env) === null ? CALENDAR_TYPES : DISPATCHED_TYPES;

export const DISPATCH_BATCH = 100;

/**
 * 通知だけの型のうち、T-07 を有効にした時刻より前に作られた行は、送らずに処理済みにする
 * （docs/specs/T-07-notification.md「古い outbox の行」決定事項5）
 */
async function skipOldNotificationRows(ctx: Ctx) {
  const startAt = notificationStartAt(ctx.env);
  if (startAt === null) return;
  await ctx.env.DB.prepare(
    `UPDATE outbox SET processed_at = ?1
     WHERE processed_at IS NULL AND created_at < ?2 AND type IN (SELECT value FROM json_each(?3))`,
  )
    .bind(ctx.deps.now(), startAt, JSON.stringify(NOTIFICATION_ONLY_TYPES))
    .run();
}

export async function dispatchOutbox(ctx: Ctx) {
  await skipOldNotificationRows(ctx);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, type, payload, created_at FROM outbox
     WHERE processed_at IS NULL AND type IN (SELECT value FROM json_each(?1))
     ORDER BY created_at, id LIMIT ?2`,
  )
    .bind(JSON.stringify(dispatchedTypes(ctx.env)), DISPATCH_BATCH)
    .all<{ id: string; type: string; payload: string; created_at: number }>();
  if (results.length === 0) return 0;
  await ctx.env.JOBS.sendBatch(
    results.map((r) => ({
      body: { kind: "outbox" as const, id: r.id, type: r.type, payload: r.payload, createdAt: r.created_at },
    })),
  );
  await ctx.env.DB.prepare(
    "UPDATE outbox SET processed_at = ?1 WHERE processed_at IS NULL AND id IN (SELECT value FROM json_each(?2))",
  )
    .bind(ctx.deps.now(), JSON.stringify(results.map((r) => r.id)))
    .run();
  return results.length;
}

/**
 * 期限を過ぎた連携の state・.ics のトークン・ログイン開始の記録とログインコード・冪等キー、古いお知らせと日ごとの数、
 * 参照されないリンクのプレビューと画像を消す
 */
export async function cleanupExpired(ctx: Ctx) {
  const now = ctx.deps.now();
  await deleteExpiredOauthStates(ctx.env.DB, now - OAUTH_STATE_TTL_MS);
  await deleteExpiredIcsTokens(ctx.env.DB, now);
  await deleteExpiredLoginRecords(identityDb(ctx.env.DB), now);
  await deleteExpiredIdempotencyKeys(ctx.env.DB, now);
  await cleanupNotifications(ctx);
  await cleanupLinkPreviews(ctx);
}
