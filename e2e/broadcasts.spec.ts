import type { Page } from "@playwright/test";
import { befriend, expect, newUser, test, type E2EUser } from "./fixtures";

// T-05 募集（docs/specs/T-05-broadcast.md「E2Eテスト」）
// 夜の時間が過去にならないよう、日付は明日（Asia/Tokyo）を使う

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

/** A が友達全員（初期値）に募集する。作った募集の詳細を開いたまま、その ID を返す */
async function createBroadcast(owner: E2EUser, opts: { expiresIn?: string; area?: string } = {}) {
  await owner.page.goto("/broadcasts/new");
  await expect(owner.page.getByRole("list", { name: "宛先" })).toBeVisible();
  await owner.page.getByLabel("日付").fill(tomorrow());
  await owner.page.getByLabel("開始", { exact: true }).fill("10:00");
  await owner.page.getByLabel("終了", { exact: true }).fill("12:00");
  if (opts.area) await owner.page.getByLabel("エリア（任意）").fill(opts.area);
  if (opts.expiresIn) await owner.page.getByLabel("返事の期限").selectOption(opts.expiresIn);
  await owner.page.getByRole("button", { name: "募集する" }).click();
  await expect(owner.page).toHaveURL(/\/broadcasts\/[0-9a-f-]+$/);
  return owner.page.url().split("/").at(-1) ?? "";
}

async function openReceived(page: Page, owner: E2EUser) {
  await page.goto("/invites?tab=broadcasts");
  await page.getByRole("list", { name: "受け取った募集" }).getByRole("link").filter({ hasText: owner.displayName }).click();
  await expect(page.getByText(owner.displayName)).toBeVisible();
}

/** E2E 環境だけの経路で、募集者の募集の期限を過ぎた状態にする（決定事項5） */
async function expireBroadcast(owner: E2EUser, id: string) {
  const refreshed = await owner.context.request.post("/api/v1/auth/refresh", { headers: { Origin: "http://localhost:5173" } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await owner.context.request.post(`/__e2e__/broadcasts/${id}/expire`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(res.status()).toBe(204);
}

async function meetupsOf(page: Page) {
  await page.goto("/invites?tab=meetups");
}

test("AがB・C・Dに募集 → BとCが応じる → Aには人数だけ → 決める → A・B・Cに予定、Dは募集中のまま", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const [b, c, d] = [await newUser(browser, "B"), await newUser(browser, "C"), await newUser(browser, "D")];
  for (const f of [b, c, d]) await befriend(a, f);
  const id = await createBroadcast(a);

  for (const f of [b, c]) {
    await openReceived(f.page, a);
    await f.page.getByRole("button", { name: "応じる" }).click();
    await expect(f.page.getByText("応じました")).toBeVisible();
  }

  await a.page.goto(`/broadcasts/${id}`);
  await expect(a.page.getByText("2人が応じています")).toBeVisible();
  await expect(a.page.getByText(b.displayName)).toHaveCount(0);
  await expect(a.page.getByText(c.displayName)).toHaveCount(0);
  await a.page.getByRole("button", { name: "決める" }).click();
  await a.page.getByRole("link", { name: "成立した予定を見る" }).click();
  await expect(a.page.getByText(new RegExp(`${b.displayName}.*${c.displayName}|${c.displayName}.*${b.displayName}`))).toBeVisible();

  await openReceived(b.page, a);
  await expect(b.page.getByText("成立", { exact: true })).toBeVisible();
  await b.page.getByRole("link", { name: "成立した予定を見る" }).click();
  await expect(b.page.getByText(a.displayName)).toBeVisible();
  await expect(b.page.getByText(c.displayName)).toBeVisible();

  await openReceived(c.page, a);
  await c.page.getByRole("link", { name: "成立した予定を見る" }).click();
  await expect(c.page.getByText(a.displayName)).toBeVisible();
  await expect(c.page.getByText(b.displayName)).toBeVisible();

  // A・B・C の「成立」に予定が出る
  for (const p of [a.page, b.page, c.page]) {
    await meetupsOf(p);
    await expect(p.getByRole("list", { name: "成立した予定" }).getByRole("listitem")).toHaveCount(1);
  }

  await openReceived(d.page, a);
  await expect(d.page.getByText("募集中")).toBeVisible();
  await expect(d.page.getByRole("button", { name: "応じる" })).toBeVisible();
});

test("誰も応じないまま期限が過ぎる → Aには「期限が過ぎました」と再募集、B・Cには「締め切りました」", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const [b, c] = [await newUser(browser, "B"), await newUser(browser, "C")];
  for (const f of [b, c]) await befriend(a, f);
  const id = await createBroadcast(a, { expiresIn: "1h", area: "渋谷" });
  await expireBroadcast(a, id);

  await a.page.goto(`/broadcasts/${id}`);
  await expect(a.page.getByText("期限が過ぎました")).toBeVisible();
  await a.page.getByRole("link", { name: "もう一度募集する" }).click();
  await expect(a.page.getByLabel(b.displayName)).toBeChecked();
  await expect(a.page.getByLabel(c.displayName)).toBeChecked();
  await expect(a.page.getByLabel("エリア（任意）")).toHaveValue("渋谷");

  for (const f of [b, c]) {
    await openReceived(f.page, a);
    await expect(f.page.getByText("締め切りました")).toBeVisible();
  }
});

test("3人の予定でBが「やっぱり難しい」→ Bの「成立」から消え、AとCには残る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const [b, c] = [await newUser(browser, "B"), await newUser(browser, "C")];
  for (const f of [b, c]) await befriend(a, f);
  const id = await createBroadcast(a);
  for (const f of [b, c]) {
    await openReceived(f.page, a);
    await f.page.getByRole("button", { name: "応じる" }).click();
    await expect(f.page.getByText("応じました")).toBeVisible();
  }
  await a.page.goto(`/broadcasts/${id}`);
  await a.page.getByRole("button", { name: "決める" }).click();
  await expect(a.page.getByRole("link", { name: "成立した予定を見る" })).toBeVisible();

  await openReceived(b.page, a);
  await b.page.getByRole("link", { name: "成立した予定を見る" }).click();
  await b.page.getByRole("button", { name: "やっぱり難しい" }).click();
  await expect(b.page.getByText("やっぱり難しくなりました")).toBeVisible();

  await meetupsOf(b.page);
  await expect(b.page.getByText("これからの成立した予定はありません")).toBeVisible();
  for (const p of [a.page, c.page]) {
    await meetupsOf(p);
    await expect(p.getByRole("list", { name: "成立した予定" }).getByRole("listitem")).toHaveCount(1);
  }
});
