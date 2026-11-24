import * as z from "zod";
import type { AppDeps, Bindings, JobMessage } from "../env";
import { syncConnection } from "../calendar/application/sync";
import { reconcileMeetup, reconcileUpcomingOf } from "../calendar/application/writes";
import { declineForCancelledAvailability } from "../invitation/application/calendarFacing";
import { handleLinkAttached } from "../link-preview/application/fetchPreview";
import { createFromEvent, deliver } from "../notification/application/delivery";
import { completeWithdrawal } from "../identity/application/withdrawal";
import { deliverContactMessage } from "../contact/application/deliver";
import { deliverReport } from "../contact/application/report";

// Queue の consumer（docs/specs/T-06-calendar.md）。kind と type で振り分ける。どの処理も冪等にしてあるので、
// 二重に届いても結果は同じ。ログには kind・type・id だけを出し、payload の中身は出さない

type Ctx = { env: Bindings; deps: AppDeps };

/** wrangler の max_retries（再試行の回数）。最初の1回と合わせて、最大 MAX_RETRIES + 1 回試す */
export const MAX_RETRIES = 5;

const meetupPayload = z.object({ meetupId: z.string() });
const connectedPayload = z.object({ userId: z.string(), after: z.string().optional() });
const cancelledPayload = z.object({
  userId: z.string(),
  ranges: z.array(z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })),
  occurredAt: z.iso.datetime(),
});
const withdrewPayload = z.object({ userId: z.string() });
const linkAttachedPayload = z.object({ subjectType: z.enum(["direct_invite", "broadcast", "wish"]), subjectId: z.string() });

/**
 * 通知のほかの処理：カレンダーの処理や自動の「今回は難しい」（T-06）、リンクのプレビューの取得（T-08）、問い合わせを Slack に届ける（T-24）。
 * 型ごとの処理がなければ何もしない。attempts はメッセージの試行の回数（1から。ない呼び出しは最後の試行として扱わない）
 */
async function handleCalendarSide(ctx: Ctx, id: string, type: string, payload: unknown, attempts: number | undefined) {
  switch (type) {
    // 問い合わせ（T-24）：Queue のメッセージの payload は使わず、受付番号で D1 の行を読む
    case "ContactMessageSubmitted":
      await deliverContactMessage(ctx, id);
      return;
    // 通報（T-33）：同じく受付番号で D1 の行を読む
    case "UserReported":
      await deliverReport(ctx, id);
      return;
    case "UserWithdrew":
      await completeWithdrawal(ctx, withdrewPayload.parse(payload).userId);
      return;
    case "LinkAttached": {
      const p = linkAttachedPayload.parse(payload);
      await handleLinkAttached(ctx, { type: p.subjectType, id: p.subjectId }, attempts !== undefined && attempts > MAX_RETRIES);
      return;
    }
    case "MeetupConfirmed":
    case "MeetupCancelled":
    case "MeetupLeft":
      await reconcileMeetup(ctx, meetupPayload.parse(payload).meetupId);
      return;
    case "CalendarConnected": {
      const p = connectedPayload.parse(payload);
      await reconcileUpcomingOf(ctx, p.userId, p.after ?? "");
      return;
    }
    case "AvailabilityCancelledByCalendar": {
      const p = cancelledPayload.parse(payload);
      await declineForCancelledAvailability(ctx, {
        userId: p.userId,
        ranges: p.ranges.map((r) => ({ startsAt: Date.parse(r.startsAt), endsAt: Date.parse(r.endsAt) })),
        occurredAt: Date.parse(p.occurredAt),
      });
      return;
    }
    default:
      return;
  }
}

export async function handleJob(ctx: Ctx, job: JobMessage, attempts?: number) {
  if (job.kind === "calendar_sync") {
    await syncConnection(ctx, job.userId, job.provider);
    return;
  }
  if (job.kind === "notification_deliver") {
    await deliver(ctx, job.notificationId);
    return;
  }
  const payload: unknown = JSON.parse(job.payload);
  // 通知を先に呼ぶ。片方が失敗しても、もう片方は試す。どちらかが失敗していれば最後に投げる
  // （どちらも冪等なので、再試行で両方をもう一度呼んでよい。docs/specs/T-07-notification.md）
  const errors: unknown[] = [];
  try {
    if (payload && typeof payload === "object") {
      await createFromEvent(ctx, {
        id: job.id,
        type: job.type,
        payload: payload as Record<string, unknown>,
        outboxCreatedAt: job.createdAt,
      });
    }
  } catch (e) {
    errors.push(e);
  }
  try {
    await handleCalendarSide(ctx, job.id, job.type, payload, attempts);
  } catch (e) {
    errors.push(e);
  }
  if (errors.length > 0) throw errors[0];
}

const describe = (job: JobMessage) =>
  job.kind === "outbox"
    ? { kind: job.kind, type: job.type, id: job.id }
    : job.kind === "notification_deliver"
      ? { kind: job.kind, id: job.notificationId }
      : { kind: job.kind };

/** 失敗したら間隔を広げて再試行し、最後の失敗は退避キューへ（wrangler の max_retries・dead_letter_queue） */
export async function handleBatch(ctx: Ctx, batch: MessageBatch<JobMessage>) {
  for (const message of batch.messages) {
    try {
      await handleJob(ctx, message.body, message.attempts);
      message.ack();
    } catch (e) {
      const fields = { ...describe(message.body), attempts: message.attempts, error: e instanceof Error ? e.name : "unknown" };
      // warn で出す：Monitors が event で数えて通知する。error にすると Workers Issues からも届き、二重になる（docs/specs/T-13-monitoring.md「3.」）
      console.warn(JSON.stringify({ event: message.attempts > MAX_RETRIES ? "job_dead_lettered" : "job_failed", ...fields }));
      message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 3600) });
    }
  }
}
