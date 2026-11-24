import type { Page } from "@playwright/test";
import { addAvailability, befriend, expect, friendList, newUser, sheet, test, type E2EUser } from "./fixtures";

// T-04 個別の誘い（docs/specs/T-04-direct-invite.md「E2Eテスト」）
// 夜の枠が過去にならないよう、日付は明日（Asia/Tokyo）を使う

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

async function addNight(page: Page, date: string) {
  await addAvailability(page, date, "夜");
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
  await sheet(page).getByRole("link", { name: "誘う", exact: true }).click();
  await expect(page.getByLabel("相手")).toHaveValue(/.+/);
  await page.getByLabel("日付").fill(tomorrow());
  await page.getByLabel("開始", { exact: true }).fill("10:00");
  await page.getByLabel("終了", { exact: true }).fill("12:00");
  await expect(sheet(page).getByText("ここどう？", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
}

async function meetupsOf(page: Page) {
  await page.goto("/invites?tab=meetups");
  return page.getByRole("list", { name: "成立した予定" });
}

test("Aが「みんな」の「誰を誘う？」から、ここ暇のないBの顔を押すと、Bを入れた誘いの作成が「ここどう？」で開き、送れる", async ({ browser }) => {
  // docs/specs/T-34-kokodou-entry.md「E2Eテスト」
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);

  await a.page.goto("/");
  await expect(a.page.getByText("まだ友達のここ暇はありません")).toBeVisible();
  await expect(a.page.getByRole("link", { name: "暇な人いる？と募る" })).toBeVisible();
  await a.page.getByRole("region", { name: "誰を誘う？" }).getByRole("link", { name: `${b.displayName}を誘う` }).click();
  const create = sheet(a.page, "誘う");
  await expect(create.getByLabel("相手").locator("option:checked")).toHaveText(b.displayName);
  await expect(create.getByText("ここどう？", { exact: true })).toBeVisible();
  await create.getByLabel("日付").fill(tomorrow());
  await create.getByLabel("開始", { exact: true }).fill("10:00");
  await create.getByLabel("終了", { exact: true }).fill("12:00");
  await create.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(sheet(a.page).getByText("返事待ち")).toBeVisible();

  await openReceived(b.page, a);
  await expect(sheet(b.page).getByText("ここどう？", { exact: true })).toBeVisible();
});

test("AがBの見えている枠から誘う（あそぼ）→ Bが「行く」→ 双方の「成立」に予定が出る", { tag: "@iphone" }, async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await addNight(b.page, tomorrow());

  await a.page.goto("/");
  await a.page.getByRole("listitem").filter({ hasText: b.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await expect(sheet(a.page).getByText("あそぼ", { exact: true })).toBeVisible();
  await a.page.getByLabel("ひとこと（任意）").fill("ごはんどう？");
  await a.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(sheet(a.page).getByText("返事待ち")).toBeVisible();

  await openReceived(b.page, a);
  await expect(sheet(b.page).getByText("あそぼ", { exact: true })).toBeVisible();
  await expect(sheet(b.page).getByText("ごはんどう？")).toBeVisible();
  await b.page.getByRole("button", { name: "行く" }).click();
  await expect(sheet(b.page).getByText("成立", { exact: true })).toBeVisible();

  await expect((await meetupsOf(a.page)).getByText(b.displayName)).toBeVisible();
  await expect((await meetupsOf(b.page)).getByText(a.displayName)).toBeVisible();
});

test("AがCに、ここ暇がない時間で誘う（ここどう？）→ Cが「この時間なら」→ Aが「決める」→ 双方に成立", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const c = await newUser(browser, "C");
  await befriend(a, c);
  await sendFromFriendDetail(a.page, c);

  await openReceived(c.page, a);
  await expect(sheet(c.page).getByText("ここどう？", { exact: true })).toBeVisible();
  await c.page.getByRole("button", { name: "この時間なら" }).click();
  await c.page.getByLabel("開始", { exact: true }).fill("13:00");
  await c.page.getByLabel("終了", { exact: true }).fill("15:00");
  await c.page.getByRole("button", { name: "この時間で返す" }).click();
  await expect(sheet(c.page).getByText("この時間ならと返しました")).toBeVisible();

  await a.page.reload();
  await expect(sheet(a.page).getByText("この時間なら", { exact: true })).toBeVisible();
  await expect(sheet(a.page).getByText(/^\d+\/\d+（.） 13:00〜15:00$/)).toBeVisible();
  await expect(sheet(a.page).getByText("最初の時間 10:00〜12:00")).toBeVisible();

  // 送信の一覧のカード（T-46）：スマホの幅で崩れず、Tab で着いたカードにフォーカスの輪が出る
  await a.page.goto("/invites?tab=sent");
  const card = a.page.getByRole("list", { name: "送信した誘い" }).getByRole("link").filter({ hasText: c.displayName });
  const badge = card.getByText("この時間なら", { exact: true });
  const name = card.getByText(`${c.displayName}さんへ`);
  await expect(badge).toBeVisible();
  await expect(card.getByText("最初の時間 10:00〜12:00")).toBeVisible();
  const [cardBox, badgeBox, nameBox] = await Promise.all([card.boundingBox(), badge.boundingBox(), name.boundingBox()]);
  expect(badgeBox!.x + badgeBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
  expect(nameBox!.width).toBeGreaterThan(40);
  await a.page.getByRole("link", { name: "成立", exact: true }).focus();
  await a.page.keyboard.press("Tab");
  await expect(card).toBeFocused();
  await expect(card).toHaveCSS("outline-style", "solid");
  await expect(card).toHaveCSS("outline-width", "2px");

  await card.click();
  await a.page.getByRole("button", { name: "13:00〜で決める" }).click();
  await expect(sheet(a.page).getByText("成立", { exact: true })).toBeVisible();

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
  await expect(sheet(b.page).getByText("今回は難しいと返しました")).toBeVisible();

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
  await expect(sheet(b.page).getByText("やっぱり難しくなりました")).toBeVisible();

  for (const page of [a.page, b.page]) {
    await page.goto("/invites?tab=meetups");
    await expect(page.getByText("これからの成立した予定はありません")).toBeVisible();
  }
  await a.page.goto(inviteUrl);
  await expect(sheet(a.page).getByText("やっぱり難しくなりました")).toBeVisible();
});

test("成立の演出（T-43）：Bが「行く」で流れ、再読み込みでは流さない。Aは最初に開いた1回だけで、動きを減らす設定では止まった一枚絵", async ({ browser }) => {
  // docs/specs/T-43-meet-moment.md「E2Eテスト」
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await sendFromFriendDetail(a.page, b);
  const inviteUrl = a.page.url();

  await openReceived(b.page, a);
  await b.page.getByRole("button", { name: "行く" }).click();
  const moment = sheet(b.page).getByRole("region", { name: "決まった！" });
  await expect(moment).toBeVisible();
  await expect(moment.getByText(`${a.displayName}と会える`)).toBeVisible();
  await expect(moment.getByRole("button", { name: "カレンダーに追加（.ics）" })).toBeVisible();
  await expect(moment.getByTestId("meet-dot")).toHaveCount(2);
  await b.page.reload();
  await expect(sheet(b.page).getByText("成立", { exact: true })).toBeVisible();
  await expect(sheet(b.page).getByText(/^\d+\/\d+（.） 10:00〜12:00$/)).toBeVisible();
  await expect(sheet(b.page).getByRole("region", { name: "決まった！" })).toHaveCount(0);

  // 誘った側：動きを減らす設定では動かさず、重なった青緑（meet）の丸だけを出す
  await a.page.emulateMedia({ reducedMotion: "reduce" });
  await a.page.goto(inviteUrl);
  const still = sheet(a.page).getByRole("region", { name: "決まった！" });
  await expect(still).toBeVisible();
  const dot = still.getByTestId("meet-dot").first();
  await expect(dot).toHaveCSS("animation-name", "none");
  await expect(dot).toHaveCSS("background-color", "rgb(15, 127, 133)");
  await a.page.reload();
  await expect(sheet(a.page).getByText("成立", { exact: true })).toBeVisible();
  await expect(sheet(a.page).getByRole("region", { name: "決まった！" })).toHaveCount(0);
});
