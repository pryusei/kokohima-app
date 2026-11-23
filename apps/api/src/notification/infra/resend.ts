import type { AppDeps, Bindings } from "../../env";
import type { Mail } from "../domain/mail";

// メールの送信（Resend）。宛先・本文・API キー・応答の本文はログに出さない
// 公式で確かめたこと：既定のレート制限は1チームで1秒10件（429）。Idempotency-Key は24時間有効で、
// 同じキーの処理中は 409 concurrent_idempotent_requests（再試行してよい）、内容が違えば 409 invalid_idempotent_request

const TIMEOUT_MS = 5000;

/** rejected：一時的でない失敗（宛先が不正、ドメインが未登録など）。一時的な失敗は投げる */
export type MailResult = { outcome: "sent" | "rejected"; status: number };

export class MailUnavailable extends Error {
  constructor(readonly status: number) {
    super("mail_unavailable");
  }
}

export async function sendMail(
  env: Bindings,
  deps: AppDeps,
  input: { to: string; mail: Mail; idempotencyKey: string },
): Promise<MailResult> {
  let res: Response;
  try {
    res = await deps.fetch(deps.notification.resendUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [input.to], subject: input.mail.subject, text: input.mail.text, html: input.mail.html }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new MailUnavailable(0);
  }
  if (res.ok) return { outcome: "sent", status: res.status };
  if (res.status === 429 || res.status >= 500) throw new MailUnavailable(res.status);
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { name?: unknown } | null;
    if (body?.name === "concurrent_idempotent_requests") throw new MailUnavailable(409);
  }
  return { outcome: "rejected", status: res.status };
}
