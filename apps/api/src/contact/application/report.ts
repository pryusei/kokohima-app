import { REPORT_DAILY_LIMIT, REPORT_LIMIT_WINDOW_HOURS, REPORT_REASONS, type ReportReason, type SafetySubject } from "@kokohima/shared";
import * as z from "zod";
import type { AppDeps, Bindings } from "../../env";
import { getContactSender } from "../../identity/application/auth";
import { actionableTarget, blockConfirmed } from "../../social/application/blocks";
import { buildReportSlackMessage } from "../domain/reportMessage";
import { checkWebhookUrl, ContactWebhookNotConfigured } from "../domain/webhook";
import { findPayload, insertIfAllowed, oldestInWindow, redact, REPORT_TYPE } from "../infra/repository";
import { postToSlack } from "../infra/slack";
import { retryAfterSeconds } from "./submit";

// 通報（docs/specs/T-33-block-report.md「振る舞い 4.」「5.」）。受け付けは outbox に1行書くだけで、Slack への送信は consumer。
// 届け先・宛先の確かめ・送り方は問い合わせ（T-24）と同じ。通報したことは相手に伝えない（outbox の行は運営に届けるためだけに使う）

type Ctx = { env: Bindings; deps: AppDeps };

export const REPORT_WINDOW_MS = REPORT_LIMIT_WINDOW_HOURS * 60 * 60 * 1000;

/** outbox の行の payload（D1 の行だけに置く。Queue のメッセージには載せない） */
export type ReportPayload = {
  /** 通報した人（閲覧者）。回数の上限と退会のときの削除はこの ID で数える */
  userId: string;
  targetUserId: string;
  reason: ReportReason;
  details: string | null;
  alsoBlock: boolean;
  subject: {
    type: SafetySubject["type"];
    id: string;
    startsAt: string;
    endsAt: string;
    area: string | null;
    message: string | null;
    url: string | null;
  } | null;
  occurredAt: string;
};

export type ReportResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/**
 * 受け付けの順番：相手を確かめる（できなければ404）→ 回数の上限と退会を1つの文で確かめて outbox に書く → 「ブロックもする」ならブロックする。
 * 受け付けのログは出さない（内容・理由・利用者 ID はどこにも出さない）
 */
export async function submitReport(
  ctx: Ctx,
  viewerId: string,
  input: { userId: string; reason: ReportReason; details?: string; subject?: SafetySubject; alsoBlock: boolean },
): Promise<ReportResult> {
  const target = await actionableTarget(ctx, viewerId, input.userId, input.subject);
  if (!target) return { kind: "not_found" };
  const now = ctx.deps.now();
  const s = target.subject;
  const payload: ReportPayload = {
    userId: viewerId,
    targetUserId: input.userId,
    reason: input.reason,
    details: input.details ?? null,
    alsoBlock: input.alsoBlock,
    subject:
      s && input.subject
        ? {
            type: input.subject.type,
            id: input.subject.id,
            startsAt: new Date(s.startsAt).toISOString(),
            endsAt: new Date(s.endsAt).toISOString(),
            area: s.area,
            message: s.message,
            url: s.url,
          }
        : null,
    occurredAt: new Date(now).toISOString(),
  };
  const inserted = await insertIfAllowed(
    ctx.env.DB,
    { id: crypto.randomUUID(), userId: viewerId, payload: JSON.stringify(payload), now },
    { count: REPORT_DAILY_LIMIT, windowMs: REPORT_WINDOW_MS },
    REPORT_TYPE,
  );
  if (!inserted) {
    if (!(await getContactSender(ctx.env, viewerId)).active) return { kind: "unauthenticated" };
    const oldest = await oldestInWindow(ctx.env.DB, viewerId, now, REPORT_WINDOW_MS, REPORT_TYPE);
    return { kind: "rate_limited", retryAfterSeconds: retryAfterSeconds(oldest, now) };
  }
  if (input.alsoBlock) await blockConfirmed(ctx, viewerId, input.userId);
  return { kind: "ok" };
}

const pending = z.object({
  userId: z.string(),
  targetUserId: z.string(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().nullable(),
  alsoBlock: z.boolean(),
  subject: z
    .object({
      type: z.enum(["direct_invite", "broadcast"]),
      id: z.string(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      area: z.string().nullable(),
      message: z.string().nullable(),
      url: z.string().nullable(),
    })
    .nullable(),
  occurredAt: z.iso.datetime(),
});
const anyRow = z.object({ userId: z.string(), occurredAt: z.string(), delivered: z.literal(true).optional() });

/**
 * 届ける処理（consumer から受付番号で呼ぶ）。手順は問い合わせ（deliverContactMessage）と同じ：
 * 行がない・届け済みなら何もしない → 通報した人が退会していたら送らずに消す → 宛先を確かめて送る → 届けたら中身を消す
 */
export async function deliverReport(ctx: Ctx, outboxId: string): Promise<void> {
  const raw = await findPayload(ctx.env.DB, outboxId, REPORT_TYPE);
  if (raw === null) return;
  const row = anyRow.parse(JSON.parse(raw));
  if (row.delivered) return;
  const p = pending.parse(JSON.parse(raw));
  const redacted = { userId: p.userId, occurredAt: p.occurredAt, delivered: true as const };

  if (!(await getContactSender(ctx.env, p.userId)).active) {
    await redact(ctx.env.DB, outboxId, redacted, REPORT_TYPE);
    return;
  }

  const message = buildReportSlackMessage({
    reason: p.reason,
    reporterId: p.userId,
    targetUserId: p.targetUserId,
    occurredAt: p.occurredAt,
    receiptId: outboxId,
    details: p.details,
    alsoBlock: p.alsoBlock,
    subject: p.subject,
  });
  const url = checkWebhookUrl(ctx.env.CONTACT_SLACK_WEBHOOK_URL, ctx.deps.contactWebhookTarget);
  if (!url) throw new ContactWebhookNotConfigured();
  await postToSlack(ctx.deps, url, message);
  await redact(ctx.env.DB, outboxId, redacted, REPORT_TYPE);

  if (!(await getContactSender(ctx.env, p.userId)).active) {
    console.warn(JSON.stringify({ event: "report_delivered_after_withdrawal", id: outboxId }));
  }
}
