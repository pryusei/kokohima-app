import type { Browser, Page } from "@playwright/test";
import { expect, loginAs, test } from "./fixtures";

// T-02 友達と招待リンク（docs/specs/T-02-friends.md「E2Eテスト」）
// 相手を見分けるため、テスト用ユーザーに一意な表示名を付ける

const uniqueName = (prefix: string) => `${prefix}${crypto.randomUUID().slice(0, 6)}`;

async function newUser(browser: Browser, prefix: string) {
  const context = await browser.newContext();
  const displayName = uniqueName(prefix);
  await loginAs(context, prefix.toLowerCase(), displayName);
  return { context, page: await context.newPage(), displayName };
}

async function createInviteUrl(page: Page) {
  await page.goto("/friends");
  await page.getByRole("button", { name: "招待リンクを作る" }).click();
  const url = await page.getByLabel("招待リンクのURL").inputValue();
  expect(url).toMatch(/\/invite#t=/);
  return url;
}

const friendList = (page: Page) => page.getByRole("list", { name: "友達一覧" });

test("リンクを開いて「友達になる」と、双方の友達一覧に相手が出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);

  await b.page.goto(url);
  await expect(b.page.getByText(a.displayName)).toBeVisible();
  await b.page.getByRole("button", { name: "友達になる" }).click();
  await expect(b.page).toHaveURL(/\/friends$/);
  await expect(friendList(b.page).getByText(a.displayName)).toBeVisible();

  await a.page.reload();
  await expect(friendList(a.page).getByText(b.displayName)).toBeVisible();
});

test("未ログインでリンクを開くとログインを求められ、ログイン後に /invite を開くと友達になれる", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const url = await createInviteUrl(a.page);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByText(a.displayName)).toBeVisible();
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
  // URLからトークンが消えている
  expect(new URL(page.url()).hash).toBe("");

  // 同じブラウザでログインする（招待Cookieが残っている）
  await loginAs(context, "c", uniqueName("C"));
  await page.goto("/invite");
  await expect(page.getByText(a.displayName)).toBeVisible();
  await page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(page).getByText(a.displayName)).toBeVisible();
});

test("無効化したリンクを開くと「このリンクは使えません」が表示される", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);
  await a.page.getByRole("button", { name: "無効にする" }).click();
  await expect(a.page.getByRole("button", { name: "無効にする" })).toHaveCount(0);

  await b.page.goto(url);
  await expect(b.page.getByText(/このリンクは使えません/)).toBeVisible();
  await expect(b.page.getByRole("button", { name: "友達になる" })).toHaveCount(0);
});

test("友達を解除すると、双方の一覧から消える", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);
  await b.page.goto(url);
  await b.page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(b.page).getByText(a.displayName)).toBeVisible();

  await a.page.reload();
  await a.page.getByRole("button", { name: "友達を解除" }).click();
  await a.page.getByRole("button", { name: `${b.displayName}さんとの友達を解除する` }).click();
  await expect(friendList(a.page).getByText(b.displayName)).toHaveCount(0);

  await b.page.reload();
  await expect(b.page.getByText("まだ友達がいません。")).toBeVisible();
});
