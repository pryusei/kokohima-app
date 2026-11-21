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

/** 開いているシート（docs/specs/T-11-design.md「画面のつながり」）。後ろのタブと文言が重なるので、シートの中で探す */
export const sheet = (page: Page, name?: string | RegExp) => page.getByRole("dialog", name === undefined ? {} : { name });

/** 招待リンクの発行はシートで開く */
export async function createInviteUrl(page: Page) {
  await page.goto("/friends");
  await page.getByRole("button", { name: "招待リンクを作る" }).click();
  const dialog = sheet(page, "招待リンクを作る");
  await dialog.getByRole("button", { name: "招待リンクを作る" }).click();
  const url = await dialog.getByLabel("招待リンクのURL").inputValue();
  expect(url).toMatch(/\/invite#t=/);
  return url;
}

export const friendList = (page: Page) => page.getByRole("list", { name: "友達一覧" });

/** ここ暇タブの「ここ暇を追加」のシートで、日付とプリセットを押して作り、シートを閉じる */
export async function addAvailability(page: Page, date: string, preset: "昼" | "夕方" | "夜" = "夜") {
  await page.goto("/availability");
  await page.getByRole("button", { name: "ここ暇を追加" }).click();
  const dialog = sheet(page, "ここ暇を追加");
  await dialog.getByLabel("日付").fill(date);
  await dialog.getByRole("button", { name: new RegExp(`^${preset} ?\\d`) }).click();
  await expect(dialog.getByText("追加しました")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
}

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
