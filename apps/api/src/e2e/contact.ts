import { env } from "cloudflare:workers";
import type { Context } from "hono";
import type { AppEnv } from "../env";

// E2E用の偽の Slack（docs/specs/T-24-contact.md「8.」）。src/e2e/entry.ts からだけ読み込む。
// 送られた JSON は、このファイルだけが作る表に残す（本番のマイグレーションには入れない。T-07 の偽のメールと同じ作り）

export const E2E_SLACK_HOST = "slack.e2e.invalid";
export const E2E_CONTACT_WEBHOOK_TARGET = { hostname: E2E_SLACK_HOST, pathPrefix: "/services/" } as const;

const USER_ID = /利用者ID：([0-9a-f-]{36})/;

async function ensureTable() {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS e2e_contact_posts (user_id TEXT NOT NULL, body TEXT NOT NULL)").run();
}

/** 偽の Slack への fetch を受ける。ほかの宛先なら null */
export async function e2eContactFetch(url: URL, init: RequestInit | undefined): Promise<Response | null> {
  if (url.host !== E2E_SLACK_HOST) return null;
  await ensureTable();
  const body = typeof init?.body === "string" ? init.body : "";
  // 「利用者ID：」の欄から送り主を取り出す（閲覧者の送信だけを返すため）
  const userId = USER_ID.exec(body)?.[1] ?? "";
  await env.DB.prepare("INSERT INTO e2e_contact_posts (user_id, body) VALUES (?1, ?2)").bind(userId, body).run();
  return new Response("ok", { status: 200 });
}

/** 閲覧者の送信だけ（並んで走るテストの送信は返さない） */
export async function e2eContactPosts(c: Context<AppEnv>) {
  await ensureTable();
  const { results } = await c.env.DB.prepare("SELECT body FROM e2e_contact_posts WHERE user_id = ?1")
    .bind(c.var.viewer.userId)
    .all<{ body: string }>();
  return c.json({ posts: results.map((r) => JSON.parse(r.body) as unknown) });
}
