import { CONTACT_DAILY_LIMIT, CONTACT_LIMIT_WINDOW_HOURS, type ContactCategory } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getContactSender } from "../../identity/application/auth";
import { insertIfAllowed, oldestInWindow, type ContactPayload } from "../infra/repository";

// 問い合わせの受け付け（docs/specs/T-24-contact.md「振る舞い 1.」）。outbox に1行書くだけ。Slack への送信は consumer

type Ctx = { env: Bindings; deps: AppDeps };

export const CONTACT_WINDOW_MS = CONTACT_LIMIT_WINDOW_HOURS * 60 * 60 * 1000;

export type SubmitResult = { kind: "ok" } | { kind: "unauthenticated" } | { kind: "rate_limited"; retryAfterSeconds: number };

/** 送り主はいつも閲覧者。受け付けのログは出さない（内容・種類・利用者 ID はどこにも出さない） */
export async function submitContactMessage(
  ctx: Ctx,
  viewerId: string,
  input: { category: ContactCategory; body: string },
): Promise<SubmitResult> {
  // 1回の要求で1つの時刻（数え直しと同じ値を使い、429 と401 を取り違えない）
  const now = ctx.deps.now();
  const payload: ContactPayload = { userId: viewerId, category: input.category, body: input.body, occurredAt: new Date(now).toISOString() };
  const inserted = await insertIfAllowed(
    ctx.env.DB,
    { id: crypto.randomUUID(), userId: viewerId, payload: JSON.stringify(payload), now },
    { count: CONTACT_DAILY_LIMIT, windowMs: CONTACT_WINDOW_MS },
  );
  if (inserted) return { kind: "ok" };
  if (!(await getContactSender(ctx.env, viewerId)).active) return { kind: "unauthenticated" };
  const oldest = await oldestInWindow(ctx.env.DB, viewerId, now, CONTACT_WINDOW_MS);
  return { kind: "rate_limited", retryAfterSeconds: retryAfterSeconds(oldest, now) };
}

/** いちばん古い受け付けが24時間を過ぎるまでの秒数（切り上げ。1以上）。読めなければ1 */
export function retryAfterSeconds(oldest: number | null, now: number): number {
  if (oldest === null) return 1;
  return Math.max(1, Math.ceil((oldest + CONTACT_WINDOW_MS - now) / 1000));
}

