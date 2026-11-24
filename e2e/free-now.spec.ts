import { befriend, expect, newUser, test } from "./fixtures";

// T-40 今ひま（docs/specs/T-40-ima-hima.md「E2Eテスト」）

test("Aが「みんな」の一番上の灯りを押すと今ひまになり、友達Bの「みんな」に「今」の印つきで出る。やめると消える", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);

  await a.page.goto("/");
  const card = a.page.getByRole("region", { name: "今ひま" });
  const light = card.getByRole("button", { name: /今から3時間ひま/ });
  await expect(light).toBeEnabled();
  const created = a.page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/v1/availabilities"));
  await light.click();
  expect((await created).status()).toBe(201);
  await expect(card.getByText(/^今ひま 〜(翌)?\d{2}:\d{2}まで$/)).toBeVisible();

  await b.page.goto("/");
  const row = b.page
    .getByRole("region", { name: "みんなのここ暇" })
    .getByRole("listitem")
    .filter({ has: b.page.getByRole("link", { name: a.displayName }) });
  await expect(row).toBeVisible();
  // 「今」の印（読み上げは「今ひま」）
  await expect(row.getByText("今ひま", { exact: true })).toBeVisible();

  const removed = a.page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/api/v1/availabilities/"));
  await card.getByRole("button", { name: "やめる" }).click();
  expect((await removed).status()).toBe(204);
  await expect(a.page.getByText("今ひまをやめました")).toBeVisible();
  await expect(a.page.getByRole("button", { name: "元に戻す" })).toBeVisible();

  await b.page.reload();
  await expect(b.page.getByText("まだ友達のここ暇はありません")).toBeVisible();
  await expect(row).toHaveCount(0);
});
