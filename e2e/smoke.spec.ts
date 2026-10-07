import { expect, test } from "@playwright/test";

test("トップを開くとサービス名が表示される", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ここ暇" })).toBeVisible();
});

test("Web から API に届く", async ({ request }) => {
  const res = await request.get("/api/v1/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ status: "ok" });
});
