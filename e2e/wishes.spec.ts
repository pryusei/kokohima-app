import { befriend, expect, newUser, sheet, test } from "./fixtures";

// T-22 行きたいリスト（docs/specs/T-22-wishlist.md「E2Eテスト」）

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

test("Aが行きたいを置く（Cを外す）→ Bの「みんな」に出てCには出ない → Bが「ここで誘う」→ 宛先がAで、ひとこと入りの誘いを送れる", async ({
  browser,
}) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const c = await newUser(browser, "C");
  await befriend(a, b);
  await befriend(a, c);
  const message = `ラーメン行きたい ${crypto.randomUUID().slice(0, 4)}`;

  await a.page.goto("/availability");
  await a.page.getByRole("button", { name: "＋ 行きたいを置く" }).click();
  const add = sheet(a.page, "行きたいを置く");
  await add.getByLabel("ひとこと").fill(message);
  await add.getByRole("button", { name: "外す人を選ぶ" }).click();
  await add.getByRole("checkbox", { name: c.displayName }).uncheck();
  await add.getByRole("button", { name: "置く", exact: true }).click();
  await expect(a.page.getByRole("list", { name: "自分の行きたい" }).getByText(message)).toBeVisible();

  // 外された C の「みんな」には出ない（友達の行きたいの応答を受け取ってから確かめる）
  const loaded = c.page.waitForResponse((r) => r.url().includes("/api/v1/friend-wishes") && r.ok());
  await c.page.goto("/");
  await loaded;
  await expect(c.page.getByRole("list", { name: "友達の行きたい" })).toHaveCount(0);
  await expect(c.page.getByText(message)).toHaveCount(0);

  await b.page.goto("/");
  const friendWishes = b.page.getByRole("list", { name: "友達の行きたい" });
  await expect(friendWishes.getByText(message)).toBeVisible();
  await friendWishes.getByRole("link", { name: "ここで誘う" }).click();

  await expect(b.page.getByLabel("ひとこと（任意）")).toHaveValue(message);
  await expect(b.page.getByLabel("相手")).toHaveValue(/.+/);
  await expect(b.page.getByLabel("相手").locator("option:checked")).toHaveText(a.displayName);
  await b.page.getByLabel("日付").fill(tomorrow());
  await b.page.getByLabel("開始", { exact: true }).fill("12:00");
  await b.page.getByLabel("終了", { exact: true }).fill("14:00");
  await b.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(b.page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
  await expect(sheet(b.page).getByText(message)).toBeVisible();
});
