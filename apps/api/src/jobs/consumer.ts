import { z } from "zod";
import type { AppDeps, Bindings, JobMessage } from "../env";
import { syncConnection } from "../calendar/application/sync";
import { reconcileMeetup, reconcileUpcomingOf } from "../calendar/application/writes";
import { declineForCancelledAvailability } from "../invitation/application/calendarFacing";
import { createFromEvent, deliver } from "../notification/application/delivery";

// Queue の consumer（docs/specs/T-06-calendar.md）。kind と type で振り分ける。どの処理も冪等にしてあるので、
// 二重に届いても結果は同じ。ログには kind・type・id だけを出し、payload の中身は出さない

type Ctx = { env: Bindings; deps: AppDeps };

/** wrangler の max_retries（再試行の回数）。最初の1回と合わせて、最大 MAX_ATTEMPTS + 1 回試す */
export const MAX_ATTEMPTS = 5;

const meetupPayload = z.object({ meetupId: z.string() });
const connectedPayload = z.object({ userId: z.string(), after: z.string().optional() });
const cancelledPayload = z.object({
  userId: z.string(),
  ranges: z.array(z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })),
  occurredAt: z.iso.datetime(),
});

/** カレンダーの処理や自動の「今回は難しい」（T-06）。型ごとの処理がなければ何もしない */
async function handleCalendarSide(ctx: Ctx, type: string, payload: unknown) {
  switch (type) {
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

export async function handleJob(ctx: Ctx, job: JobMessage) {
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
    await handleCalendarSide(ctx, job.type, payload);
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
      await handleJob(ctx, message.body);
      message.ack();
    } catch (e) {
      const fields = { ...describe(message.body), attempts: message.attempts, error: e instanceof Error ? e.name : "unknown" };
      console.error(JSON.stringify({ event: message.attempts > MAX_ATTEMPTS ? "job_dead_lettered" : "job_failed", ...fields }));
      message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 3600) });
    }
  }
}
