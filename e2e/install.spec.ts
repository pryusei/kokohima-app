import { expect, test } from "./fixtures";

// T-25 ホーム画面に追加する案内（docs/specs/T-25-installable-pwa.md「E2Eテスト」）
// ブラウザは自分から beforeinstallprompt を出さないので、テストで発火してボタンが出るところまで確かめる

test("設定 →「アプリとして使う」で案内が出て、追加の準備ができた端末ではボタンが出る", async ({ loggedInPage: page }) => {
  await page.goto("/settings");
  await page.getByRole("link", { name: /アプリとして使う/ }).click();
  await expect(page).toHaveURL(/\/settings\/install$/);
  await expect(page.getByRole("heading", { name: "アプリとして使う", level: 1 })).toBeVisible();
  await expect(page.getByText(/ホーム画面に追加/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "ホーム画面に追加" })).toHaveCount(0);

  // 追加の準備ができた端末（Chrome・Android）では、ボタンが出る
  await page.evaluate(() => {
    const g = globalThis as unknown as { dispatchEvent: (e: unknown) => void; Event: new (type: string, init?: { cancelable: boolean }) => object };
    g.dispatchEvent(Object.assign(new g.Event("beforeinstallprompt", { cancelable: true }), { prompt: () => Promise.resolve({ outcome: "dismissed" }) }));
  });
  await expect(page.getByRole("button", { name: "ホーム画面に追加" })).toBeVisible();
});

test("manifest と画像が同じオリジンから配信される", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as { icons: { src: string }[] };
  for (const icon of body.icons) expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  expect((await request.get("/apple-touch-icon.png")).ok()).toBe(true);
});
