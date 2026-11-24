import { expect, test } from "./fixtures";

test("ログイン済みでアプリを開くとホーム（みんな）になり、再読み込みしても続く", { tag: "@iphone" }, async ({ loggedInPage: page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
});

test("ログイン中、localStorage・sessionStorage にアクセストークンがない", { tag: "@iphone" }, async ({ loggedInPage: page }) => {
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

// LINE ログイン（docs/specs/T-32-line-login.md「E2Eテスト」）。LINE は偽物（E2E のエントリの /__e2e__/line/authorize）
test("ログイン画面の最初のボタンは「LINEでログイン」。押すと名前の画面になり、決めると「みんな」が開き、再読み込みしても続く", async ({ page }) => {
  await page.goto("/login");
  const buttons = page.getByRole("link", { name: /でログイン$/ });
  await expect(buttons.first()).toHaveText("LINEでログイン");
  await expect(buttons.nth(1)).toHaveText("Googleでログイン");
  // LINE の認可画面へ、state・nonce・PKCE（S256）・scope=openid つきで移る
  const authorize = page.waitForRequest((req) => req.url().includes("/__e2e__/line/authorize"));
  await buttons.first().click();
  const url = new URL((await authorize).url());
  expect(url.searchParams.get("scope")).toBe("openid");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.searchParams.get("nonce")).toBeTruthy();
  // メールアドレスも名前も受け取らないので、名前の画面（T-31）で決める
  await expect(page.getByRole("heading", { name: "表示名を決めてください" })).toBeVisible();
  await page.getByLabel("表示名").fill(`L${crypto.randomUUID().slice(0, 6)}`);
  await page.getByRole("button", { name: "これで始める" }).click();
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "みんな" })).toBeVisible();
});

for (const name of ["プライバシー ポリシー", "利用規約"]) {
  test(`未ログインで、ログイン画面から「${name}」を開き、「戻る」でログイン画面に戻る`, async ({ page }) => {
    // docs/specs/T-19-privacy-terms.md「E2Eテスト」
    await page.goto("/login");
    await expect(page.getByText("続けると利用規約とプライバシー ポリシーに同意したことになります")).toBeVisible();
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(`${name}｜ここ暇`);
    await page.getByRole("button", { name: "戻る" }).click();
    await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page).toHaveTitle("ここ暇");
  });
}
