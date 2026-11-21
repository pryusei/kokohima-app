import type { Page } from "@playwright/test";
import { befriend, expect, friendList, newUser, test, type E2EUser } from "./fixtures";

// T-08 リンクのプレビュー（docs/specs/T-08-link-preview.md「E2Eテスト」）。取得先は E2E のエントリの偽のサイト（ogp.e2e.invalid）
// 並んで走るテストが同じ URL を取り合わないよう、URL にテストごとの値を付ける。日付は明日（Asia/Tokyo）

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}
const pageUrl = () => `https://ogp.e2e.invalid/page?r=${crypto.randomUUID().slice(0, 8)}`;
const missingUrl = () => `https://ogp.e2e.invalid/missing?r=${crypto.randomUUID().slice(0, 8)}`;

/** E2E 環境だけの経路で、outbox を Queue を通さずに処理する */
async function drain(user: E2EUser) {
  const refreshed = await user.context.request.post("/api/v1/auth/refresh", { headers: { Origin: "http://localhost:5173" } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await user.context.request.post("/__e2e__/outbox/drain", { headers: { Authorization: `Bearer ${accessToken}` } });
  expect(res.ok()).toBe(true);
}

/** 友達の詳細から、リンク付きで誘う */
async function inviteWithLink(page: Page, to: E2EUser, url: string) {
  await page.goto("/friends");
  await friendList(page).getByRole("link", { name: to.displayName }).click();
  await page.getByRole("link", { name: "ここどう？と誘う" }).click();
  await expect(page.getByLabel("相手")).toHaveValue(/.+/);
  await page.getByLabel("日付").fill(tomorrow());
  await page.getByLabel("開始", { exact: true }).fill("10:00");
  await page.getByLabel("終了", { exact: true }).fill("12:00");
  await page.getByLabel("リンク（任意）").fill(url);
  await page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
}

async function openReceived(page: Page, from: E2EUser) {
  await page.goto("/invites?tab=received");
  await page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: from.displayName }).click();
}

test("AがBにリンク付きで誘う → outbox を処理する → Bの誘いの詳細にタイトル・説明・画像のカードが出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await inviteWithLink(a.page, b, pageUrl());
  // 処理するまではドメインだけ
  await expect(a.page.getByRole("link", { name: "ogp.e2e.invalid" })).toBeVisible();
  await drain(a);

  await openReceived(b.page, a);
  const card = b.page.getByRole("link", { name: /E2E のお店/ });
  await expect(card).toBeVisible();
  await expect(card.getByText("駅から3分のお店です")).toBeVisible();
  await expect(card.getByText("ogp.e2e.invalid")).toBeVisible();
  const img = card.locator("img");
  await expect(img).toHaveAttribute("src", /^\/api\/v1\/link-previews\/images\/[0-9a-f-]{36}$/);
  await expect.poll(() => img.evaluate((el) => (el as unknown as { complete: boolean; naturalWidth: number }).complete && (el as unknown as { naturalWidth: number }).naturalWidth)).toBe(1);
});

test("Aがリンク付きで募集する → outbox を処理する → 宛先の詳細にカードが出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const [b, c] = [await newUser(browser, "B"), await newUser(browser, "C")];
  for (const f of [b, c]) await befriend(a, f);
  await a.page.goto("/broadcasts/new");
  await expect(a.page.getByRole("list", { name: "宛先" })).toBeVisible();
  await a.page.getByLabel("日付").fill(tomorrow());
  await a.page.getByLabel("開始", { exact: true }).fill("10:00");
  await a.page.getByLabel("終了", { exact: true }).fill("12:00");
  await a.page.getByLabel("リンク（任意）").fill(pageUrl());
  await a.page.getByRole("button", { name: "募集する" }).click();
  await expect(a.page).toHaveURL(/\/broadcasts\/[0-9a-f-]+$/);
  await drain(a);

  await b.page.goto("/invites?tab=broadcasts");
  await b.page.getByRole("list", { name: "受け取った募集" }).getByRole("link").filter({ hasText: a.displayName }).click();
  await expect(b.page.getByRole("link", { name: /E2E のお店/ })).toBeVisible();
});

test("取れないリンク（偽のサイトが404）では、ドメインだけが出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await inviteWithLink(a.page, b, missingUrl());
  await drain(a);

  await openReceived(b.page, a);
  await expect(b.page.getByRole("link", { name: "ogp.e2e.invalid", exact: true })).toBeVisible();
  await expect(b.page.locator("main img")).toHaveCount(0);
});
