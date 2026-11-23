import type { BrowserContext } from "@playwright/test";
import { expect, test } from "./fixtures";

// T-24 問い合わせ（docs/specs/T-24-contact.md「E2Eテスト」）。Slack は E2E のエントリの偽物（slack.e2e.invalid）に向く。
// E2E では API の公開の日を 0 に、画面の __CONTACT_FORCE_OPEN__ を true にして、公開の日によらずに回す

type Posts = { posts: { text: string; blocks: { text?: { text: string } }[] }[] };

/** 閲覧者として API を呼ぶ（Origin は、そのプロジェクトの画面に合わせる。iphone は HTTPS の画面） */
async function api(context: BrowserContext, method: "GET" | "POST", path: string) {
  const origin = test.info().project.use.baseURL ?? "http://localhost:5173";
  const refreshed = await context.request.post("/api/v1/auth/refresh", { headers: { Origin: origin } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await context.request.fetch(path, { method, headers: { Authorization: `Bearer ${accessToken}` } });
  expect(res.ok()).toBe(true);
  return res;
}

test("友達タブ → 設定 → 問い合わせで、不具合を送ると「送りました」が出て、偽の Slack にエスケープされて1通届く", { tag: "@iphone" }, async ({
  loggedInPage: page,
  context,
}) => {
  await page.goto("/friends");
  await page.getByRole("link", { name: /設定/ }).first().click();
  await page.getByRole("link", { name: /問い合わせ/ }).click();
  await expect(page.getByRole("heading", { name: "問い合わせ", level: 1 })).toBeVisible();

  const marker = crypto.randomUUID().slice(0, 8);
  await page.getByRole("button", { name: "不具合" }).click();
  await page.getByLabel("内容").fill(`<!channel> & テスト ${marker}\n2行目`);
  await expect(page.getByText(/^\d+ \/ 1000$/)).toBeVisible();
  // 入力欄が画面の幅をはみ出さない
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "送る" }).click();
  await expect(page.getByRole("heading", { name: "送りました" })).toBeVisible();
  await expect(page.getByLabel("内容")).toHaveCount(0);

  await api(context, "POST", "/__e2e__/outbox/drain");
  const { posts } = (await (await api(context, "GET", "/__e2e__/contact/posts")).json()) as Posts;
  expect(posts).toHaveLength(1);
  const sent = JSON.stringify(posts[0]);
  expect(posts[0]?.text).toBe("問い合わせ：不具合");
  expect(sent).toContain(`&lt;!channel&gt; &amp; テスト ${marker}`);
  expect(sent).not.toContain("<!channel>");
});
