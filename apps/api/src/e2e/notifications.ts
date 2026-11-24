import { env } from "cloudflare:workers";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { getNotificationAddress } from "../identity/application/auth";
import { handleJob } from "../jobs/consumer";
import { sha256 } from "../shared/crypto";

// E2E用の偽のメール配信・偽のプッシュのサービス（docs/specs/T-07-notification.md「E2E用の偽のメール・プッシュ」）
// src/e2e/entry.ts からだけ読み込む。送った中身は、このファイルだけが作る表に残す（本番のマイグレーションには入れない）

const FAKE_MAIL_HOST = "resend.e2e.invalid";
export const E2E_PUSH_HOST = "push.e2e.invalid";
export const E2E_NOTIFICATION_DEPS = {
  resendUrl: `https://${FAKE_MAIL_HOST}/emails`,
  extraPushHosts: [E2E_PUSH_HOST],
  // CI がいつ走っても、プッシュの流れを確かめられるように、夜に鳴らさない決まりを外す（T-35。単体テストで確かめる）
  quietHours: false,
} as const;

async function ensureTables() {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS e2e_sent_mails (idempotency_key TEXT PRIMARY KEY, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL)",
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS e2e_sent_pushes (endpoint_hash TEXT NOT NULL, body_length INTEGER NOT NULL)"),
  ]);
}

/** 偽の宛先への fetch を受ける。ほかの宛先なら null */
export async function e2eNotificationFetch(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  if (url.host === FAKE_MAIL_HOST) {
    await ensureTables();
    const mail = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { to?: string[]; subject?: string; text?: string };
    // 本物と同じく、同じ Idempotency-Key の送信は1通にまとめる
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? crypto.randomUUID();
    await env.DB.prepare("INSERT OR IGNORE INTO e2e_sent_mails (idempotency_key, recipient, subject, body) VALUES (?1, ?2, ?3, ?4)")
      .bind(key, mail.to?.[0] ?? "", mail.subject ?? "", mail.text ?? "")
      .run();
    return Response.json({ id: key });
  }
  if (url.host === E2E_PUSH_HOST) {
    await ensureTables();
    const bodyLength = init?.body instanceof Uint8Array ? init.body.byteLength : init?.body == null ? 0 : String(init.body).length;
    await env.DB.prepare("INSERT INTO e2e_sent_pushes (endpoint_hash, body_length) VALUES (?1, ?2)")
      .bind(await sha256(url.toString()), bodyLength)
      .run();
    return new Response(null, { status: 201 });
  }
  return null;
}

/**
 * 閲覧者宛ての、まだ届けていないお知らせを、Queue を通さずにすぐ届ける（outbox の drain のあとに呼ぶ）。
 * 並んで走るほかのテストのお知らせには触れない
 */
export async function e2eDeliverPending(c: Context<AppEnv>) {
  const { results } = await c.env.DB.prepare(
    "SELECT id FROM notifications WHERE user_id = ?1 AND delivered_at IS NULL ORDER BY inserted_at, id LIMIT 200",
  )
    .bind(c.var.viewer.userId)
    .all<{ id: string }>();
  for (const r of results) {
    await handleJob({ env: c.env, deps: c.var.deps }, { kind: "notification_deliver", notificationId: r.id });
  }
  return results.length;
}

/** 閲覧者に送ったメールと、閲覧者の購読に送ったプッシュ */
export async function e2eNotificationsSent(c: Context<AppEnv>) {
  await ensureTables();
  const userId = c.var.viewer.userId;
  const address = await getNotificationAddress(c.env, userId);
  const mails = address
    ? (await c.env.DB.prepare("SELECT subject, body FROM e2e_sent_mails WHERE recipient = ?1").bind(address).all<{ subject: string; body: string }>())
        .results
    : [];
  const pushes = (
    await c.env.DB.prepare(
      `SELECT p.body_length AS bodyLength FROM e2e_sent_pushes p
       WHERE p.endpoint_hash IN (SELECT endpoint_hash FROM push_subscriptions WHERE user_id = ?1)`,
    )
      .bind(userId)
      .all<{ bodyLength: number }>()
  ).results;
  return c.json({ mails, pushes });
}
