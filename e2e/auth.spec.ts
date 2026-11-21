import { expect, test } from "./fixtures";

test("ログイン済みでアプリを開くとホーム（みんな）になり、再読み込みしても続く", async ({ loggedInPage: page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
});

test("ログイン中、localStorage・sessionStorage にアクセストークンがない", async ({ loggedInPage: page }) => {
  const tokens: string[] = [];
  page.on("response", async (res) => {
    if (res.url().endsWith("/api/v1/auth/refresh") && res.ok()) {
      tokens.push(((await res.json()) as { accessToken: string }).accessToken);
    }
  });
  // 応答の中身を読み終える前に見出しが出ることがあるので、更新の応答を待ってから確かめる
  const refreshed = page.waitForResponse((res) => res.url().endsWith("/api/v1/auth/refresh") && res.ok());
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
  tokens.push(((await (await refreshed).json()) as { accessToken: string }).accessToken);
  expect(tokens.length).toBeGreaterThan(0);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  for (const token of tokens) expect(stored).not.toContain(token);
});

test("友達タブ → 設定 → アカウントからログアウトするとログイン画面になり、再読み込みしてもログアウトのまま", async ({
  loggedInPage: page,
}) => {
  // 設定は友達タブの「アカウント」の節から開く（docs/specs/T-11-design.md「画面のつながり」）
  await page.goto("/friends");
  await page.getByRole("link", { name: /設定/ }).click();
  await page.getByRole("link", { name: /^アカウント/ }).click();
  await expect(page.getByRole("heading", { name: "アカウント", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "ログアウト", exact: true }).click();
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
});

test("未ログインで / を開くとログイン画面になる", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Appleでログイン" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});
