import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../env";
import { e2eApp as app } from "./entry";

// E2E の偽の Slack と、確かめる経路（docs/specs/T-24-contact.md「8.」「テスト計画」）

const ORIGIN = env.APP_ORIGIN;
const bindings = { ...env, E2E_MODE: "1", CONTACT_SLACK_WEBHOOK_URL: "https://slack.e2e.invalid/services/e2e" } as Bindings;

async function loginAs(name: string) {
  const res = await app.request(
    "/__e2e__/login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: `${name}-${crypto.randomUUID()}` }) },
    bindings,
  );
  expect(res.status).toBe(204);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-kh_rt="))?.split(";")[0] ?? "";
  const refreshed = await app.request("/api/v1/auth/refresh", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } }, bindings);
  expect(refreshed.status).toBe(200);
  return ((await refreshed.json()) as { accessToken: string }).accessToken;
}

const call = (token: string, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  );

type Posts = { posts: { blocks: { text?: { text: string } }[] }[] };

describe("E2E の問い合わせ", () => {
  it("E2E のエントリは公開の日によらずに受け付け、偽の Slack に届き、確かめる経路は閲覧者の送信だけを返す", async () => {
    const a = await loginAs("ca");
    const b = await loginAs("cb");
    expect((await call(a, "POST", "/api/v1/contact-messages", { category: "bug", body: "<!channel> & A の内容" })).status).toBe(204);
    expect((await call(b, "POST", "/api/v1/contact-messages", { category: "other", body: "B の内容" })).status).toBe(204);
    expect((await call(a, "POST", "/__e2e__/outbox/drain")).status).toBe(200);

    const posts = (await (await call(a, "GET", "/__e2e__/contact/posts")).json()) as Posts;
    expect(posts.posts).toHaveLength(1);
    const text = JSON.stringify(posts.posts[0]);
    expect(text).toContain("&lt;!channel&gt; &amp; A の内容");
    expect(text).not.toContain("<!channel>");
    expect(text).not.toContain("B の内容");

    const bPosts = (await (await call(b, "GET", "/__e2e__/contact/posts")).json()) as Posts;
    expect(JSON.stringify(bPosts)).toContain("B の内容");
    expect(JSON.stringify(bPosts)).not.toContain("A の内容");
  });

  it("確かめる経路は、ログインしていなければ401、E2E_MODE でなければ404", async () => {
    expect((await app.request("/__e2e__/contact/posts", {}, bindings)).status).toBe(401);
    expect((await app.request("/__e2e__/contact/posts", {}, { ...bindings, E2E_MODE: undefined })).status).toBe(404);
  });
});
