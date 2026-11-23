import type { AppDeps } from "../../env";
import { ContactWebhookRejected } from "../domain/webhook";

// Slack の Incoming Webhook への送信（docs/specs/T-24-contact.md「振る舞い 3.」の5）。
// 転送に従わず（3xx も失敗）、5秒で打ち切る。URL・応答の本文・内容は例外にもログにも出さない

const TIMEOUT_MS = 5000;

export async function postToSlack(deps: AppDeps, url: URL, message: unknown): Promise<void> {
  let res: Response;
  try {
    res = await deps.fetch(url.toString(), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ContactWebhookRejected(0);
  }
  // 本文は読まずに捨てる（中身をどこにも残さない）
  await res.body?.cancel().catch(() => undefined);
  if (res.status !== 200) throw new ContactWebhookRejected(res.status);
}
