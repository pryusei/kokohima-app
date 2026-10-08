import type { Page } from "@playwright/test";
import { befriend, expect, friendList, newUser, test } from "./fixtures";

// T-03 ここ暇（docs/specs/T-03-availability.md「E2Eテスト」）
// 夜の枠が過去にならないよう、日付は明日（Asia/Tokyo）を使う

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function tokyoDate(offsetDays: number) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
    new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000),
  );
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const [, m, d] = date.split("-").map(Number);
  return { date, weekday, label: `${m}/${d}（${WEEKDAYS[weekday]}）` };
}

async function addNight(page: Page, date: string) {
  await page.goto("/availability");
  await page.getByLabel("日付").fill(date);
  await page.getByRole("button", { name: "夜", exact: true }).click();
  await expect(page.getByRole("list", { name: "自分のここ暇" }).getByText(/夜 19:00〜23:00/)).toBeVisible();
}

async function openFriendDetail(page: Page, displayName: string) {
  await page.goto("/friends");
  await friendList(page).getByRole("link", { name: displayName }).click();
  await expect(page.getByRole("heading", { name: displayName })).toBeVisible();
}

test("Aが「夜」でここ暇を作ると、友達Bの「みんな」に表示名と「夜 19:00〜23:00」が出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const tomorrow = tokyoDate(1);
  await addNight(a.page, tomorrow.date);

  await b.page.goto("/");
  const day = b.page.getByRole("heading", { name: tomorrow.label }).locator("..");
  const item = day.getByRole("listitem").filter({ hasText: a.displayName });
  await expect(item).toContainText("夜 19:00〜23:00");
});

test("AがBに「見せない」にすると、Bの「みんな」と友達の詳細から消え、ここ暇のない友達Cと同じ表示になる", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const c = await newUser(browser, "C");
  await befriend(a, b);
  await befriend(c, b);
  const tomorrow = tokyoDate(1);
  await addNight(a.page, tomorrow.date);

  await b.page.goto("/");
  await expect(b.page.getByRole("link", { name: a.displayName })).toBeVisible();
  await openFriendDetail(b.page, a.displayName);
  await expect(b.page.getByRole("list", { name: "友達のここ暇" })).toContainText("夜 19:00〜23:00");

  await a.page.goto("/friends");
  const row = friendList(a.page).getByRole("listitem").filter({ hasText: b.displayName });
  const saved = a.page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/v1/friends/"));
  await row.getByRole("switch").click();
  expect((await saved).status()).toBe(200);
  await expect(row.getByRole("switch")).not.toBeChecked();

  await b.page.goto("/");
  await expect(b.page.getByText("まだ友達のここ暇はありません")).toBeVisible();
  await expect(b.page.getByRole("link", { name: a.displayName })).toHaveCount(0);

  for (const friend of [a, c]) {
    await openFriendDetail(b.page, friend.displayName);
    await expect(b.page.getByText("見えているここ暇はありません")).toBeVisible();
    await expect(b.page.getByRole("list", { name: "友達のここ暇" }).getByRole("listitem")).toHaveCount(0);
  }
});

test("毎週のくり返しを作ると自分の一覧に出て、「この日だけ外す」とその日だけ消える", async ({ loggedInPage: page }) => {
  const tomorrow = tokyoDate(1);
  const nextWeek = tokyoDate(8);
  await page.goto("/availability");
  await page.getByLabel("曜日").selectOption(String(tomorrow.weekday));
  await page.getByLabel("時間帯", { exact: true }).selectOption("night");
  await page.getByRole("button", { name: "くり返しを追加" }).click();
  await expect(page.getByRole("list", { name: "くり返し" })).toContainText(`毎週${WEEKDAYS[tomorrow.weekday]}曜 夜 19:00〜23:00`);

  const mine = page.getByRole("list", { name: "自分のここ暇" });
  const first = mine.getByRole("listitem").filter({ hasText: `${tomorrow.label} 夜 19:00〜23:00` });
  const second = mine.getByRole("listitem").filter({ hasText: `${nextWeek.label} 夜 19:00〜23:00` });
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  await first.getByRole("button", { name: "この日だけ外す" }).click();
  await expect(first).toHaveCount(0);
  await page.reload();
  await expect(second).toBeVisible();
  await expect(first).toHaveCount(0);
  await expect(page.getByText(`${tomorrow.label}は外しています`)).toBeVisible();
});
