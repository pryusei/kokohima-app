import type { Page } from "@playwright/test";
import { befriend, expect, friendList, newUser, test, type E2EUser } from "./fixtures";

// T-04 個別の誘い（docs/specs/T-04-direct-invite.md「E2Eテスト」）
// 夜の枠が過去にならないよう、日付は明日（Asia/Tokyo）を使う

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

async function addNight(page: Page, date: string) {
  await page.goto("/availability");
  await page.getByLabel("日付").fill(date);
  await page.getByRole("button", { name: "夜", exact: true }).click();
  await expect(page.getByRole("list", { name: "自分のここ暇" }).getByText(/夜 19:00〜23:00/)).toBeVisible();
}

/** 受信した誘いのうち、相手の名前のものを開く */
async function openReceived(page: Page, from: E2EUser) {
  await page.goto("/invites?tab=received");
  await page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: from.displayName }).click();
}

async function sendFromFriendDetail(page: Page, to: E2EUser) {
  await page.goto("/friends");
  await friendList(page).getByRole("link", { name: to.displayName }).click();
  await page.getByRole("link", { name: "ここどう？と誘う" }).click();
  await expect(page.getByLabel("相手")).toHaveValue(/.+/);
  await page.getByLabel("日付").fill(tomorrow());
  await page.getByLabel("開始", { exact: true }).fill("10:00");
  await page.getByLabel("終了", { exact: true }).fill("12:00");
  await expect(page.getByText("ここどう？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
}

async function meetupsOf(page: Page) {
  await page.goto("/invites?tab=meetups");
  return page.getByRole("list", { name: "成立した予定" });
}

test("AがBの見えている枠から誘う（あそぼ）→ Bが「行く」→ 双方の「成立」に予定が出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await addNight(b.page, tomorrow());

  await a.page.goto("/");
  await a.page.getByRole("listitem").filter({ hasText: b.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await expect(a.page.getByText("あそぼ", { exact: true })).toBeVisible();
  await a.page.getByLabel("ひとこと（任意）").fill("ごはんどう？");
  await a.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(a.page.getByText("返事待ち")).toBeVisible();

  await openReceived(b.page, a);
  await expect(b.page.getByRole("heading", { name: "あそぼ" })).toBeVisible();
  await expect(b.page.getByText("ごはんどう？")).toBeVisible();
  await b.page.getByRole("button", { name: "行く" }).click();
  await expect(b.page.getByText("成立", { exact: true })).toBeVisible();

  await expect((await meetupsOf(a.page)).getByText(b.displayName)).toBeVisible();
  await expect((await meetupsOf(b.page)).getByText(a.displayName)).toBeVisible();
});

test("AがCに、ここ暇がない時間で誘う（ここどう？）→ Cが「この時間なら」→ Aが「決める」→ 双方に成立", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const c = await newUser(browser, "C");
  await befriend(a, c);
  await sendFromFriendDetail(a.page, c);

  await openReceived(c.page, a);
  await expect(c.page.getByRole("heading", { name: "ここどう？" })).toBeVisible();
  await c.page.getByRole("button", { name: "この時間なら" }).click();
  await c.page.getByLabel("開始", { exact: true }).fill("13:00");
  await c.page.getByLabel("終了", { exact: true }).fill("15:00");
  await c.page.getByRole("button", { name: "この時間で返す" }).click();
  await expect(c.page.getByText("この時間ならと返しました")).toBeVisible();

  await a.page.reload();
  await expect(a.page.getByText(/この時間なら：.* 13:00〜15:00/)).toBeVisible();
  await a.page.getByRole("button", { name: "決める" }).click();
  await expect(a.page.getByText("成立", { exact: true })).toBeVisible();

  await expect((await meetupsOf(a.page)).getByText(/13:00〜15:00/)).toBeVisible();
  await expect((await meetupsOf(c.page)).getByText(a.displayName)).toBeVisible();
});

test("AがBに誘う → Bが「今回は難しい」→ Aの送信の一覧に「今回は難しいみたい」と静かに出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await sendFromFriendDetail(a.page, b);

  await openReceived(b.page, a);
  await b.page.getByRole("button", { name: "今回は難しい" }).click();
  await expect(b.page.getByText("今回は難しいと返しました")).toBeVisible();

  await a.page.goto("/invites?tab=sent");
  const item = a.page.getByRole("list", { name: "送信した誘い" }).getByRole("listitem").filter({ hasText: b.displayName });
  await expect(item.getByText("今回は難しいみたい")).toBeVisible();
});

test("成立した予定で「やっぱり難しい」→ 双方の「成立」から消え、誘いの詳細に「やっぱり難しくなりました」", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await sendFromFriendDetail(a.page, b);
  const inviteUrl = a.page.url();
  await openReceived(b.page, a);
  await b.page.getByRole("button", { name: "行く" }).click();
  await b.page.getByRole("link", { name: "成立した予定を見る" }).click();
  await b.page.getByRole("button", { name: "やっぱり難しい" }).click();
  await expect(b.page.getByText("やっぱり難しくなりました")).toBeVisible();

  for (const page of [a.page, b.page]) {
    await page.goto("/invites?tab=meetups");
    await expect(page.getByText("これからの成立した予定はありません")).toBeVisible();
  }
  await a.page.goto(inviteUrl);
  await expect(a.page.getByText("やっぱり難しくなりました")).toBeVisible();
});
