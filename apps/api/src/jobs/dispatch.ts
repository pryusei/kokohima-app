import type { AppDeps, Bindings } from "../env";
import { deleteExpiredIcsTokens, deleteExpiredOauthStates } from "../calendar/infra/repository";
import { db as identityDb, deleteDeadSessions, deleteExpiredLoginRecords } from "../identity/infra/repository";
import { OAUTH_STATE_TTL_MS } from "../calendar/application/connections";
import { cleanupNotifications, notificationStartAt } from "../notification/application/delivery";
import { NOTIFICATION_ONLY_TYPES } from "../notification/domain/events";
import { deleteExpiredIdempotencyKeys } from "../shared/idempotency";
import { cleanupLinkPreviews } from "../link-preview/application/previews";
import { deleteManualStartedBefore } from "../availability/infra/repository";
import { MAX_LENGTH_MS } from "../availability/domain/validation";
import { retryIncompleteWithdrawals } from "../identity/application/withdrawal";

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
  "UserWithdrew",
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
/** 1回の実行で繰り返す回数の上限。1分に最大1000件（docs/specs/T-12-data-growth.md） */
export const DISPATCH_MAX_ROUNDS = 10;
/** 実行を始めてからこれを過ぎたら、次の回に入らない（次の Cron の実行と重ならないように） */
export const DISPATCH_TIME_BUDGET_MS = 20 * 1000;

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

/**
 * 100件ずつ流すのを、未処理の行がなくなるまで（最大 DISPATCH_MAX_ROUNDS 回・DISPATCH_TIME_BUDGET_MS まで）繰り返す。送った数。
 * 打ち切ったら件数だけのログを出す（docs/specs/T-12-data-growth.md「ログの一覧」）
 */
export async function dispatchOutbox(ctx: Ctx) {
  await skipOldNotificationRows(ctx);
  const startedAt = ctx.deps.now();
  let sent = 0;
  for (let round = 0; round < DISPATCH_MAX_ROUNDS; round++) {
    if (round > 0 && ctx.deps.now() - startedAt >= DISPATCH_TIME_BUDGET_MS) {
      console.log(JSON.stringify({ event: "outbox_dispatch_capped", reason: "time", sent }));
      return sent;
    }
    const n = await dispatchOnce(ctx);
    sent += n;
    if (n < DISPATCH_BATCH) return sent;
  }
  console.log(JSON.stringify({ event: "outbox_dispatch_capped", reason: "count", sent }));
  return sent;
}

/** 1回分：最大100件を読み、送ってから処理済みにする。送った数 */
async function dispatchOnce(ctx: Ctx) {
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
 * 期限を過ぎた連携の state・.ics のトークン・ログイン開始の記録とログインコード・冪等キー、失効・期限切れから30日を過ぎたセッションと更新用トークン、古いお知らせと日ごとの数、
 * 参照されないリンクのプレビューと画像を消す
 */
export async function cleanupExpired(ctx: Ctx) {
  const now = ctx.deps.now();
  const d1 = ctx.env.DB;
  // 1つが失敗しても残りは走る（docs/specs/T-12-data-growth.md「定期処理の独立とログ」）
  await runStep("cleanup_oauth_states", () => deleteExpiredOauthStates(d1, now - OAUTH_STATE_TTL_MS));
  await runStep("cleanup_ics_tokens", () => deleteExpiredIcsTokens(d1, now));
  await runStep("cleanup_login_records", () => deleteExpiredLoginRecords(identityDb(d1), now));
  await runStep("cleanup_sessions", () => deleteDeadSessions(d1, now));
  await runStep("cleanup_idempotency_keys", () => deleteExpiredIdempotencyKeys(d1, now));
  await runStep("cleanup_notifications", () => cleanupNotifications(ctx));
  await runStep("cleanup_link_previews", () => cleanupLinkPreviews(ctx));
  await runStep("cleanup_outbox", () => deleteProcessedOutbox(d1, now - OUTBOX_RETENTION_MS, CLEANUP_BATCH));
  await runStep("cleanup_availabilities", () =>
    deleteManualStartedBefore(d1, now - AVAILABILITY_RETENTION_MS, CLEANUP_BATCH),
  );
  // 退会の後始末の取りこぼし（docs/specs/T-16-withdrawal.md）
  await runStep("retry_withdrawals", () => retryIncompleteWithdrawals(ctx));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 処理済みの outbox の行を残す期間（退避キューの既定の保持期間4日より長く） */
export const OUTBOX_RETENTION_MS = 7 * DAY_MS;
/** 始まりがこれより前の手動の枠を消す。長さは最大24時間なので、どれも終わってから1日以上たっている */
export const AVAILABILITY_RETENTION_MS = DAY_MS + MAX_LENGTH_MS;
/** 1回の実行で消す行の数の上限（outbox・ここ暇） */
export const CLEANUP_BATCH = 1000;

/** 処理済みになってから retention を過ぎた outbox の行を消す（上限つき）。未処理の行は消さない。消した数 */
export async function deleteProcessedOutbox(d1: D1Database, processedBefore: number, limit: number) {
  const r = await d1
    .prepare("DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE processed_at < ?1 LIMIT ?2)")
    .bind(processedBefore, limit)
    .run();
  return r.meta.changes;
}

/**
 * 定期処理の1つを走らせる。例外は投げ直さず、処理の名前と例外の名前だけをログに出す
 * （メッセージ・スタック・SQL の値は個人情報やトークンを含みうるので出さない）
 */
export async function runStep(step: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.log(JSON.stringify({ event: "cron_step_failed", step, name: e instanceof Error ? e.name : "unknown" }));
  }
}
