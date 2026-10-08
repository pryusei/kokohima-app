import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// 認証状態はテストの間で使い回さない。更新用トークンはページを開くたびに交換され、
// 同じトークンを別のテストが送ると再利用として系列ごと失効するため（docs/specs/T-01-auth.md）

/** テスト用ログインで、このコンテキスト専用の新しいセッションを作る */
export async function loginAs(context: BrowserContext, name: string, displayName?: string): Promise<string> {
  const user = `${name}-${crypto.randomUUID()}`;
  const res = await context.request.post("/__e2e__/login", { data: { user, displayName } });
  expect(res.status()).toBe(204);
  return user;
}

/** 相手を見分けるための一意な表示名 */
export const uniqueName = (prefix: string) => `${prefix}${crypto.randomUUID().slice(0, 6)}`;

/** 別のブラウザコンテキストで、表示名つきのユーザーとしてログインする */
export async function newUser(browser: Browser, prefix: string) {
  const context = await browser.newContext();
  const displayName = uniqueName(prefix);
  await loginAs(context, prefix.toLowerCase(), displayName);
  return { context, page: await context.newPage(), displayName };
}

export type E2EUser = Awaited<ReturnType<typeof newUser>>;

export async function createInviteUrl(page: Page) {
  await page.goto("/friends");
  await page.getByRole("button", { name: "招待リンクを作る" }).click();
  const url = await page.getByLabel("招待リンクのURL").inputValue();
  expect(url).toMatch(/\/invite#t=/);
  return url;
}

export const friendList = (page: Page) => page.getByRole("list", { name: "友達一覧" });

/** inviter の招待リンクから invitee が友達になる */
export async function befriend(inviter: E2EUser, invitee: E2EUser) {
  const url = await createInviteUrl(inviter.page);
  await invitee.page.goto(url);
  await invitee.page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(invitee.page).getByText(inviter.displayName)).toBeVisible();
}

export const test = base.extend<{ loggedInPage: Page }>({
  /** ユーザーAとしてログイン済みのページ */
  loggedInPage: async ({ context, page }, use) => {
    await loginAs(context, "a");
    await use(page);
  },
});

export { expect };
