import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { befriend, expect, newUser, test, type E2EUser } from "./fixtures";

// T-06 カレンダー連携（docs/specs/T-06-calendar.md「E2Eテスト」）。Google は E2E のエントリの偽の実装に向く
// 夜の枠が過去にならないよう、日付は明日（Asia/Tokyo）を使う

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}
/** 東京の日付と時刻 → UTC の ISO */
const at = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+09:00`).toISOString();

/** E2E 環境だけの経路を、その利用者として呼ぶ */
async function e2e(user: E2EUser, path: string, data?: unknown) {
  const refreshed = await user.context.request.post("/api/v1/auth/refresh", { headers: { Origin: "http://localhost:5173" } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await user.context.request.post(path, { headers: { Authorization: `Bearer ${accessToken}` }, data });
  expect(res.ok()).toBe(true);
  return res;
}

const setBusy = (user: E2EUser, busy: { startsAt: string; endsAt: string }[]) => e2e(user, "/__e2e__/calendar/busy", { busy });
const sync = (user: E2EUser) => e2e(user, "/__e2e__/calendar/sync");
const drain = (user: E2EUser) => e2e(user, "/__e2e__/outbox/drain");

async function connect(page: Page) {
  await page.goto("/settings/calendar");
  await expect(page.getByText("連携していません")).toBeVisible();
  await page.getByRole("button", { name: "Googleカレンダーと連携" }).click();
  await expect(page.getByText("連携しました")).toBeVisible();
  await expect(page.getByText("連携中")).toBeVisible();
}

const mine = (page: Page) => page.getByRole("list", { name: "自分のここ暇" });

test("連携：設定で連携 → 偽の認可画面 → 「連携中」→ 「連携をやめる」で「連携していません」", async ({ browser }) => {
  const a = await newUser(browser, "A");
  await a.page.goto("/friends");
  await a.page.getByRole("link", { name: "カレンダー連携" }).click();
  await connect(a.page);
  await a.page.getByRole("button", { name: "連携をやめる" }).click();
  await expect(a.page.getByText("連携していません")).toBeVisible();
});

test("候補：連携した人のここ暇タブに候補が出て、押すとここ暇になる。埋まりと重なる時間帯は出ない", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const date = tomorrow();
  await setBusy(a, [{ startsAt: at(date, "17:00"), endsAt: at(date, "18:00") }]);
  await connect(a.page);
  await a.page.goto("/availability");
  const candidates = a.page.getByRole("button", { name: /夜 19:00〜23:00/ });
  const tomorrowLabel = new RegExp(`^${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}（.）`);
  await expect(candidates.filter({ hasText: tomorrowLabel })).toBeVisible();
  await expect(a.page.getByRole("button", { name: /夕方 16:00〜19:00/ }).filter({ hasText: tomorrowLabel })).toHaveCount(0);
  await candidates.filter({ hasText: tomorrowLabel }).click();
  await expect(mine(a.page).getByText(/夜 19:00〜23:00/)).toBeVisible();
  await expect(candidates.filter({ hasText: tomorrowLabel })).toHaveCount(0);
});

test("自動取り消し：A のここ暇が実予定で消え、B の誘いが「今回は難しい」になる", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const date = tomorrow();
  await setBusy(a, []);
  await connect(a.page);
  // 最初の確認は記録だけ。ここ暇を作ってからもう一度確かめ、作った枠を「前回の確認より前」にする
  await sync(a);
  await a.page.goto("/availability");
  await a.page.getByLabel("日付").fill(date);
  await a.page.getByRole("button", { name: "夜", exact: true }).click();
  await expect(mine(a.page).getByText(/夜 19:00〜23:00/)).toBeVisible();
  await sync(a);

  await b.page.goto("/");
  await b.page.getByRole("listitem").filter({ hasText: a.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await b.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(b.page.getByText("返事待ち")).toBeVisible();

  await setBusy(a, [{ startsAt: at(date, "20:00"), endsAt: at(date, "21:00") }]);
  await sync(a);
  await drain(a);

  await a.page.goto("/availability");
  await expect(a.page.getByRole("heading", { name: "ここ暇を追加" })).toBeVisible();
  await expect(mine(a.page).getByText(/夜 19:00〜23:00/)).toHaveCount(0);
  await b.page.goto("/invites?tab=sent");
  const item = b.page.getByRole("list", { name: "送信した誘い" }).getByRole("listitem").filter({ hasText: a.displayName });
  await expect(item.getByText("今回は難しいみたい")).toBeVisible();
});

test(".ics：成立した予定の詳細から .ics を開くと、中身に予定の時刻がある", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const date = tomorrow();
  await b.page.goto("/availability");
  await b.page.getByLabel("日付").fill(date);
  await b.page.getByRole("button", { name: "夜", exact: true }).click();
  await expect(mine(b.page).getByText(/夜 19:00〜23:00/)).toBeVisible();

  await a.page.goto("/");
  await a.page.getByRole("listitem").filter({ hasText: b.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await a.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(a.page.getByText("返事待ち")).toBeVisible();
  await b.page.goto("/invites?tab=received");
  await b.page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: a.displayName }).click();
  await b.page.getByRole("button", { name: "行く" }).click();
  await expect(b.page.getByText("成立", { exact: true })).toBeVisible();

  await a.page.goto("/invites?tab=meetups");
  await a.page.getByRole("list", { name: "成立した予定" }).getByRole("link").filter({ hasText: b.displayName }).click();
  const downloading = a.page.waitForEvent("download");
  await a.page.getByRole("button", { name: "カレンダーに追加（.ics）" }).click();
  const download = await downloading;
  const text = await readFile((await download.path()) ?? "", "utf8");
  const start = at(date, "19:00").replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  expect(text).toContain("BEGIN:VEVENT");
  expect(text).toContain(`DTSTART:${start}`);
  expect(text).toContain(`SUMMARY:ここ暇：${b.displayName}`);
});
