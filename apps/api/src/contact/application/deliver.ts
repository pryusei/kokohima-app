import { CONTACT_CATEGORIES } from "@kokohima/shared";
import * as z from "zod";
import type { AppDeps, Bindings } from "../../env";
import { getContactSender } from "../../identity/application/auth";
import { buildSlackMessage } from "../domain/slackMessage";
import { checkWebhookUrl, ContactWebhookNotConfigured } from "../domain/webhook";
import { findPayload, redact } from "../infra/repository";
import { postToSlack } from "../infra/slack";

// 届ける処理（docs/specs/T-24-contact.md「振る舞い 3.」）。consumer から受付番号で呼ぶ。
// Queue のメッセージの payload は使わず、D1 の outbox の行を読む。何度呼んでも、Slack に届くのは原則1通

type Ctx = { env: Bindings; deps: AppDeps };

const pending = z.object({
  userId: z.string(),
  category: z.enum(CONTACT_CATEGORIES),
  body: z.string(),
  occurredAt: z.iso.datetime(),
});
const anyRow = z.object({ userId: z.string(), occurredAt: z.string(), delivered: z.literal(true).optional() });

export async function deliverContactMessage(ctx: Ctx, outboxId: string): Promise<void> {
  // 1. 行がない（退会・掃除で消えた）・届け済みなら何もしない
  const raw = await findPayload(ctx.env.DB, outboxId);
  if (raw === null) return;
  const row = anyRow.parse(JSON.parse(raw));
  if (row.delivered) return;
  const p = pending.parse(JSON.parse(raw));
  const redacted = { userId: p.userId, occurredAt: p.occurredAt, delivered: true as const };

  // 2. 退会していたら送らずに内容を消す
  const sender = await getContactSender(ctx.env, p.userId);
  if (!sender.active) {
    await redact(ctx.env.DB, outboxId, redacted);
    return;
  }

  // 3・4. 文を組み立て、宛先を確かめる（違えば送らない）
  const message = buildSlackMessage({ ...p, email: sender.email, receiptId: outboxId });
  const url = checkWebhookUrl(ctx.env.CONTACT_SLACK_WEBHOOK_URL, ctx.deps.contactWebhookTarget);
  if (!url) throw new ContactWebhookNotConfigured();

  // 5. 送る（200 以外は投げて、Queue の再試行に任せる）
  await postToSlack(ctx.deps, url, message);

  // 6. 届けたら種類と内容を消す（まだ届けていない行だけ）
  await redact(ctx.env.DB, outboxId, redacted);

  // 7. 送る間に退会していたら、受付番号だけを出す（運営者が Slack で消す）
  if (!(await getContactSender(ctx.env, p.userId)).active) {
    console.warn(JSON.stringify({ event: "contact_delivered_after_withdrawal", id: outboxId }));
  }
}
