import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { addAvailability, availabilityCell, befriend, expect, newUser, sheet, test, type E2EUser } from "./fixtures";

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
/** 端末のカレンダーのボタン（Chromium は「ほかの」、WebKit は「Macの」など。端末で名前が変わる。T-59） */
const DEVICE_CALENDAR = /^(?:iPhone|iPad|Mac|ほか)のカレンダーに追加$/;

async function connect(page: Page) {
  await page.goto("/settings/calendar");
  await expect(page.getByText("連携していません")).toBeVisible();
  await page.getByRole("button", { name: "Googleカレンダーと連携" }).click();
  await expect(page.getByText("連携しました")).toBeVisible();
  await expect(page.getByText("連携中")).toBeVisible();
}


test("連携：設定で連携 → 偽の認可画面 → 「連携中」→ 「連携をやめる」で「連携していません」", async ({ browser }) => {
  const a = await newUser(browser, "A");
  // 設定は友達タブの「アカウント」の節から開く（docs/specs/T-11-design.md）
  await a.page.goto("/friends");
  await a.page.getByRole("link", { name: /設定/ }).click();
  await a.page.getByRole("link", { name: /カレンダー連携/ }).click();
  await connect(a.page);
  await a.page.getByRole("button", { name: "連携をやめる" }).click();
  await expect(a.page.getByText("連携していません")).toBeVisible();
});

test("候補：連携した人の週の帯で、空いているマスに「カレンダーで空き」の点が出て、押すとここ暇になる。埋まりと重なる時間帯には出ない", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const date = tomorrow();
  await setBusy(a, [{ startsAt: at(date, "17:00"), endsAt: at(date, "18:00") }]);
  await connect(a.page);
  await a.page.goto("/availability");
  // 点は見た目の印。読み上げの名前に「カレンダーで空き」が入る（docs/specs/T-55-availability-week-grid.md）
  const night = availabilityCell(a.page, date, "夜");
  await expect(night).toHaveAccessibleName(/ 19:00〜23:00 カレンダーで空き。押すとここ暇にする$/);
  await expect(availabilityCell(a.page, date, "夕方")).toHaveAccessibleName(/ 16:00〜19:00。押すとここ暇にする$/);
  await night.click();
  await expect(night).toHaveAccessibleName(/ ここ暇 19:00〜23:00。押すと取り消す$/);
  await a.page.reload();
  await expect(night).toHaveAccessibleName(/ ここ暇 19:00〜23:00。押すと取り消す$/);
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
  await addAvailability(a.page, date, "夜");
  await sync(a);

  await b.page.goto("/");
  await b.page.getByRole("listitem").filter({ hasText: a.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await b.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(sheet(b.page).getByText("返事待ち")).toBeVisible();

  await setBusy(a, [{ startsAt: at(date, "20:00"), endsAt: at(date, "21:00") }]);
  await sync(a);
  await drain(a);

  await a.page.goto("/availability");
  await expect(a.page.getByRole("heading", { name: /^自分のここ暇/ })).toBeVisible();
  await expect(availabilityCell(a.page, date, "夜")).toHaveAccessibleName(/押すとここ暇にする$/);
  await b.page.goto("/invites?tab=sent");
  const item = b.page.getByRole("list", { name: "送信した誘い" }).getByRole("listitem").filter({ hasText: a.displayName });
  await expect(item.getByText("今回は難しいみたい")).toBeVisible();
});

/** a が b のここ暇（明日の夜）に誘い、b が「行く」で成立させて、a が成立した予定の詳細を開く */
async function openMeetupFromInvite(a: E2EUser, b: E2EUser) {
  const date = tomorrow();
  await addAvailability(b.page, date, "夜");
  await a.page.goto("/");
  await a.page.getByRole("listitem").filter({ hasText: b.displayName }).getByRole("link", { name: "この時間に誘う" }).click();
  await a.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(sheet(a.page).getByText("返事待ち")).toBeVisible();
  await b.page.goto("/invites?tab=received");
  await b.page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: a.displayName }).click();
  await b.page.getByRole("button", { name: "行く" }).click();
  await expect(sheet(b.page).getByText("成立", { exact: true })).toBeVisible();

  await a.page.goto("/invites?tab=meetups");
  await a.page.getByRole("list", { name: "成立した予定" }).getByRole("link").filter({ hasText: b.displayName }).click();
  return date;
}

test(".ics：成立した予定の詳細から .ics を開くと、中身に予定の時刻がある", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const date = await openMeetupFromInvite(a, b);
  const downloading = a.page.waitForEvent("download");
  // 「カレンダーに追加」で開く、端末のカレンダーのボタン（名前は端末で変わる。docs/specs/T-59-choose-calendar-add.md「振る舞い 1.」）
  await sheet(a.page).getByRole("button", { name: "カレンダーに追加", exact: true }).click();
  await sheet(a.page).getByRole("button", { name: DEVICE_CALENDAR }).click();
  const download = await downloading;
  const text = await readFile((await download.path()) ?? "", "utf8");
  const start = at(date, "19:00").replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  expect(text).toContain("BEGIN:VEVENT");
  expect(text).toContain(`DTSTART:${start}`);
  expect(text).toContain(`SUMMARY:ここ暇：${b.displayName}`);
});

test("成立した予定からカレンダーに追加（T-59）：連携していなくても「カレンダーに追加」で Google の追加画面のリンクと端末のカレンダーが開く", async ({ browser }) => {
  // docs/specs/T-59-choose-calendar-add.md「E2Eテスト」。Google の画面は外のサイトなので開かず、リンクの中身を確かめる
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const date = await openMeetupFromInvite(a, b);

  const add = sheet(a.page).getByRole("button", { name: "カレンダーに追加", exact: true });
  await expect(add).toHaveAttribute("aria-expanded", "false");
  await add.click();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  const google = sheet(a.page).getByRole("link", { name: "Googleカレンダーに追加" });
  await expect(google).toBeVisible();
  await expect(google).toHaveAttribute("target", "_blank");
  const url = new URL((await google.getAttribute("href")) ?? "");
  expect(`${url.origin}${url.pathname}`).toBe("https://calendar.google.com/calendar/render");
  expect(url.searchParams.get("text")).toBe(`ここ暇：${b.displayName}`);
  const stamp = (hhmm: string) => at(date, hhmm).replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  expect(url.searchParams.get("dates")).toBe(`${stamp("19:00")}/${stamp("23:00")}`);
  await expect(sheet(a.page).getByRole("button", { name: DEVICE_CALENDAR })).toBeVisible();
  await expect(sheet(a.page).getByText("押した予定だけが入ります")).toBeVisible();
  // 自動で入れる話・連携のボタンは出さない
  await expect(sheet(a.page).getByText(/自動で入/)).toHaveCount(0);
});
