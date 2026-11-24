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

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「YYYY-MM-DD」→ 画面の日付「11/25（水）」 */
export function dateLabel(date: string) {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}（${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}）`;
}

/**
 * ここ暇タブの週の帯のマス（docs/specs/T-55-availability-week-grid.md）。名前は「11/25（水） 夜 …」で始まり、
 * 続きに状態（ここ暇・くり返しのここ暇・カレンダーで空き）と押すと何が起きるかが入る
 */
export const availabilityCell = (page: Page, date: string, preset: "昼" | "夕方" | "夜") =>
  page.getByRole("button", { name: new RegExp(`^${dateLabel(date)} ${preset} `) });

/** ここ暇タブの週の帯で、その日付と時間帯のマスを押して作る（今日から7日より先なら「次の7日」に進む） */
export async function addAvailability(page: Page, date: string, preset: "昼" | "夕方" | "夜" = "夜") {
  await page.goto("/availability");
  const cell = availabilityCell(page, date, preset);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  if (Date.parse(date) - Date.parse(today) >= 7 * 24 * 60 * 60 * 1000) await page.getByRole("button", { name: "次の7日 ›" }).click();
  await expect(cell).toHaveAttribute("aria-pressed", "false");
  await expect(cell).toBeEnabled();
  await cell.click();
  // 作れたら下に「…をここ暇にしました」と「取り消す」が出る
  await expect(page.getByText(`${dateLabel(date)} ${preset}をここ暇にしました`)).toBeVisible();
  await expect(cell).toHaveAccessibleName(/ ここ暇 \d/);
}

/** inviter の招待リンクから invitee が友達になる */
export async function befriend(inviter: E2EUser, invitee: E2EUser) {
  const url = await createInviteUrl(inviter.page);
  await invitee.page.goto(url);
  await invitee.page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(invitee.page).getByText(inviter.displayName)).toBeVisible();
}

export const test = base.extend<{ loggedInPage: Page }>({
  /** ユーザーAとしてログイン済みのページ。名前の画面（docs/specs/T-31-display-name-first-step.md）を通らないよう表示名を付ける */
  loggedInPage: async ({ context, page }, use) => {
    await loginAs(context, "a", uniqueName("A"));
    await use(page);
  },
});

export { expect };
