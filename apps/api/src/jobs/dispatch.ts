import { RETENTION, RETENTION_UNIT_MS } from "@kokohima/shared";
import type { AppDeps, Bindings, JobMessage } from "../env";
import { deleteExpiredIcsTokens, deleteExpiredOauthStates } from "../calendar/infra/repository";
import { db as identityDb, deleteDeadSessions, deleteExpiredLoginRecords } from "../identity/infra/repository";
import { OAUTH_STATE_TTL_MS } from "../calendar/application/connections";
import {
  cleanupNotifications,
  NOTIFICATION_CLEANUP_BATCH,
  notificationStartAt,
} from "../notification/application/delivery";
import { NOTIFICATION_ONLY_TYPES } from "../notification/domain/events";
import { deleteExpiredIdempotencyKeys } from "../shared/idempotency";
import { cleanupLinkPreviews } from "../link-preview/application/previews";
import { cleanupAvatars } from "../identity/application/avatar";
import { deleteExceptionsBefore, deleteManualStartedBefore } from "../availability/infra/repository";
import { deleteInvitesEndedBefore } from "../invitation/infra/repository";
import { deleteBroadcastsEndedBefore } from "../invitation/infra/broadcastRepository";
import { deleteInviteLinksExpiredBefore } from "../social/infra/repository";
import { MAX_LENGTH_MS } from "../availability/domain/validation";
import { retryIncompleteWithdrawals } from "../identity/application/withdrawal";
import { deleteOldAttempts as deleteOldWishSuggestionAttempts } from "../wish/application/suggestions";
import { deleteOldPosts as deleteOldWishPosts } from "../wish/application/wishes";

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
  // 問い合わせを Slack に届ける（docs/specs/T-24-contact.md「振る舞い 2.」）
  "ContactMessageSubmitted",
] as const;

/**
 * Queue のメッセージに payload を載せない型（docs/specs/T-24-contact.md「振る舞い 2.」）。
 * Queue のメッセージは再試行の間と退避キューに残り、退会で D1 の行を消しても残るため。consumer は受付番号で D1 の行を読む
 */
export const ID_ONLY_TYPES: readonly string[] = ["ContactMessageSubmitted"];

/** outbox の行から Queue のメッセージを作る（dispatchOnce と、E2E の outbox を流す経路の両方が使う） */
export function toJobMessage(row: { id: string; type: string; payload: string; created_at: number }): Extract<JobMessage, { kind: "outbox" }> {
  return {
    kind: "outbox",
    id: row.id,
    type: row.type,
    payload: ID_ONLY_TYPES.includes(row.type) ? "{}" : row.payload,
    createdAt: row.created_at,
  };
}

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
    results.map((r) => ({ body: toJobMessage(r) })),
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
 * 参照されないリンクのプレビューと画像、終わってから30日を過ぎた誘い・募集（予定ごと）、期限から30日を過ぎた招待リンク、過去のくり返しの例外、
 * 流れないままの通知の記録を消す（保持期間の一覧は docs/specs/T-17-retention.md「1.」）
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
  await runCappedStep("cleanup_notifications", NOTIFICATION_CLEANUP_BATCH, () => cleanupNotifications(ctx));
  await runStep("cleanup_link_previews", () => cleanupLinkPreviews(ctx));
  await runStep("cleanup_avatars", () => cleanupAvatars(ctx));
  await runStep("cleanup_outbox", () => deleteProcessedOutbox(d1, now - OUTBOX_RETENTION_MS, CLEANUP_BATCH));
  await runStep("cleanup_availabilities", () =>
    deleteManualStartedBefore(d1, now - AVAILABILITY_RETENTION_MS, CLEANUP_BATCH),
  );
  // 保持期間（docs/specs/T-17-retention.md「2.」〜「6.」）
  const cutoff = now - RETENTION_MS;
  await runCappedStep("cleanup_invitations", CLEANUP_BATCH, () => deleteInvitesEndedBefore(d1, cutoff, CLEANUP_BATCH));
  await runCappedStep("cleanup_broadcasts", BROADCAST_CLEANUP_BATCH, () =>
    deleteBroadcastsEndedBefore(d1, cutoff, BROADCAST_CLEANUP_BATCH),
  );
  await runCappedStep("cleanup_invite_links", CLEANUP_BATCH, () => deleteInviteLinksExpiredBefore(d1, cutoff, CLEANUP_BATCH));
  await runCappedStep("cleanup_recurrence_exceptions", CLEANUP_BATCH, () =>
    deleteExceptionsBefore(d1, exceptionCutoffDate(now), CLEANUP_BATCH),
  );
  if (notificationStartAt(ctx.env) === null) {
    await runCappedStep("cleanup_stale_notification_outbox", CLEANUP_BATCH, () =>
      deleteStaleNotificationOutbox(d1, cutoff, CLEANUP_BATCH),
    );
  }
  // 行きたいを置いた記録（2日。docs/specs/T-22-wishlist.md「期限と保存期間」）
  await runCappedStep("cleanup_wish_posts", CLEANUP_BATCH, () => deleteOldWishPosts(d1, now, CLEANUP_BATCH));
  // 行きたいのAI提案の回数の記録（UTC で3日前の日付より前。docs/specs/T-29-wish-suggestion.md「データ」）
  await runCappedStep("cleanup_wish_suggestion_attempts", CLEANUP_BATCH, () =>
    deleteOldWishSuggestionAttempts(d1, now, CLEANUP_BATCH),
  );
  // 退会の後始末の取りこぼし（docs/specs/T-16-withdrawal.md）
  await runStep("retry_withdrawals", () => retryIncompleteWithdrawals(ctx));
}

const DAY_MS = RETENTION_UNIT_MS.day;
/**
 * 誘い・募集（時間の終わりから）、招待リンク（期限から）、流れないままの通知の記録（作ってから）を残す期間。
 * ちょうど30日の行は残す（docs/specs/T-17-retention.md「1.」）
 */
export const RETENTION_MS = RETENTION.invitationsDays * DAY_MS;
/** 1回に消す募集の数の上限（宛先が最大100人いて、CASCADE で消える行が多いため） */
export const BROADCAST_CLEANUP_BATCH = 100;

/** くり返しの例外は、日付が UTC の今日の2日前の日付より前なら消す（タイムゾーンの差は最大1日なので、どこでも過去の日付） */
export const exceptionCutoffDate = (now: number) => new Date(now - RETENTION.recurrenceExceptionDaysBefore * DAY_MS).toISOString().slice(0, 10);

/**
 * NOTIFICATION_START_AT が未設定の間だけ呼ぶ：通知だけの型で、未処理で、作ったのが createdBefore より前の outbox の行を消す
 * （上限つき。インデックス outbox_unprocessed）。未設定の間は流れず処理済みにもならないので、処理済みの掃除では消えない。消した数
 */
export async function deleteStaleNotificationOutbox(d1: D1Database, createdBefore: number, limit: number) {
  const r = await d1
    .prepare(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox
         WHERE processed_at IS NULL AND created_at < ?1 AND type IN (SELECT value FROM json_each(?2))
         LIMIT ?3
       )`,
    )
    .bind(createdBefore, JSON.stringify(NOTIFICATION_ONLY_TYPES), limit)
    .run();
  return r.meta.changes;
}
/** 処理済みの outbox の行を残す期間（退避キューの既定の保持期間4日より長く） */
export const OUTBOX_RETENTION_MS = RETENTION.processedOutboxDays * DAY_MS;
/** 始まりがこれより前の手動の枠を消す。長さは最大24時間なので、どれも終わってから1日以上たっている */
export const AVAILABILITY_RETENTION_MS = RETENTION.availabilityGraceDays * DAY_MS + MAX_LENGTH_MS;
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
    // warn で出す（Monitors が数える。Workers Issues と二重にしない。docs/specs/T-13-monitoring.md「3.」）
    console.warn(JSON.stringify({ event: "cron_step_failed", step, name: e instanceof Error ? e.name : "unknown" }));
  }
}

/**
 * 上限つきの掃除を runStep で走らせ、上限いっぱいまで処理した（残っている見込み）ときは件数だけのログを出す
 * （docs/specs/T-17-retention.md「9.」。ID は出さない）
 */
export async function runCappedStep(step: string, limit: number, fn: () => Promise<number>) {
  await runStep(step, async () => {
    const count = await fn();
    if (count >= limit) console.log(JSON.stringify({ event: "cleanup_capped", step, count }));
  });
}

export type CronName = "minutely" | "calendar_sync";

/** 定期処理が終わりまで動いた時刻を記録する（docs/specs/T-13-monitoring.md「定期処理が動いた記録」） */
export async function recordCronRun(d1: D1Database, name: CronName, now: number) {
  await d1
    .prepare("INSERT INTO cron_runs (name, last_run_at) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at")
    .bind(name, now)
    .run();
}
