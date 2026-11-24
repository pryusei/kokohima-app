import { expect, test, type Page } from "@playwright/test";

// 本番と同じ形で画面を開く（docs/specs/T-12-release.md「E2Eテスト」）。wrangler dev --env assets（本番と同じエントリと静的アセット）に向ける。
// ログインはしない（テスト用ログインの経路を本番のエントリに入れないため）

/** CSP の違反を、securitypolicyviolation のイベントとコンソールの両方で数える */
async function watchViolations(page: Page) {
  const messages: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) messages.push(m.text());
  });
  // E2E の tsconfig は DOM の型を読まないので、ページの中の値は最小の型で扱う
  type PageGlobal = {
    __cspViolations: string[];
    document: { addEventListener: (type: string, f: (e: { violatedDirective: string; blockedURI: string }) => void) => void };
  };
  await page.addInitScript(() => {
    const g = globalThis as unknown as PageGlobal;
    g.__cspViolations = [];
    g.document.addEventListener("securitypolicyviolation", (e) => {
      g.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return async () => [...messages, ...(await page.evaluate(() => (globalThis as unknown as PageGlobal).__cspViolations))];
}

// /invite は未ログインでも InvitePage を描画する（トークンがないので「使えません」）。/privacy・/terms は本文。ほかは未ログインなのでログインの画面
const pages: { path: string; rendered: (page: Page) => ReturnType<Page["getByRole"]> }[] = [
  // 未ログインの / は、JavaScript なしの紹介のページ（docs/specs/T-44-landing.md）
  { path: "/", rendered: (page) => page.getByRole("heading", { name: "ここ暇", level: 1 }) },
  { path: "/login", rendered: (page) => page.getByRole("link", { name: "Googleでログイン" }) },
  { path: "/invites/00000000-0000-4000-8000-000000000000", rendered: (page) => page.getByRole("link", { name: "Googleでログイン" }) },
  { path: "/invite", rendered: (page) => page.getByRole("status").filter({ hasText: "このリンクは使えません" }) },
  // プライバシー ポリシーと利用規約はログインしなくても出る（docs/specs/T-19-privacy-terms.md）
  { path: "/privacy", rendered: (page) => page.getByRole("heading", { name: "プライバシー ポリシー", level: 1 }) },
  { path: "/terms", rendered: (page) => page.getByRole("heading", { name: "利用規約", level: 1 }) },
];

for (const { path, rendered } of pages) {
  test(`本番と同じ形で ${path} を開くと、画面が出て、CSP の違反がなく、ヘッダーが付く`, async ({ page }) => {
    const violations = await watchViolations(page);
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    const headers = res?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["cache-control"]).toBe("no-cache");
    // 画面が描画される
    await expect(rendered(page)).toBeVisible();
    // 本番のビルドには Apple のボタンがない
    await expect(page.getByRole("link", { name: "Appleでログイン" })).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(await violations()).toEqual([]);
  });
}

test("本番と同じ形では、ハッシュ付きの /assets/ は1年の immutable、/sw.js は no-cache（docs/specs/T-49-perf-small-fixes.md）", async ({ page, request }) => {
  const assets: { url: string; cacheControl: string | undefined }[] = [];
  page.on("response", (r) => {
    if (new URL(r.url()).pathname.startsWith("/assets/")) assets.push({ url: r.url(), cacheControl: r.headers()["cache-control"] });
  });
  // /privacy は遅延読み込みのチャンクも読む
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "プライバシー ポリシー", level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(assets.length).toBeGreaterThan(0);
  for (const a of assets) expect(a.cacheControl, a.url).toBe("public, max-age=31536000, immutable");
  expect((await request.get("/sw.js")).headers()["cache-control"]).toBe("no-cache");
});

test("本番と同じ形では、画面の側の POST は405で、テスト用ログインの経路はない", async ({ request }) => {
  const post = await request.post("/__e2e__/login", { data: {} });
  expect(post.status()).toBe(405);
  const api = await request.get("/api/v1/health");
  expect(api.status()).toBe(200);
  expect(api.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
});

// 紹介のページ（docs/specs/T-44-landing.md「テスト計画」）。Google の審査のホームページ
test.describe("JavaScript を切って / を開く", () => {
  test.use({ javaScriptEnabled: false });

  test("見出し・3つの手順・3つの約束・ログインとポリシーと規約へのリンクが読める", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle("ここ暇");
    await expect(page.getByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
    const how = page.getByRole("region", { name: "どう使うの？" });
    await expect(how.getByRole("listitem")).toHaveCount(3);
    await expect(how).toContainText("誘われてもいい時間に「ここ暇」を置きます。");
    const promise = page.getByRole("region", { name: "3つの約束" });
    await expect(promise.getByRole("listitem")).toHaveCount(3);
    for (const text of ["いる場所は出しません。", "予定の中身は見ません。", "広告はありません。"]) await expect(promise).toContainText(text);
    await expect(page.getByRole("link", { name: "はじめる・ログイン" })).toHaveAttribute("href", "/login");
    await expect(page.getByRole("link", { name: "プライバシー ポリシー" })).toHaveAttribute("href", "/privacy");
    await expect(page.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    await expect(page.getByRole("link", { name: "ops@kokohima.app" })).toHaveAttribute("href", "mailto:ops@kokohima.app");
  });
});

test("JavaScript ありでも / は紹介のページで、「はじめる・ログイン」からログインの画面に進む", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
  await page.getByRole("link", { name: "はじめる・ログイン" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
});

test("ログインの Cookie があると / は SPA で、Cookie が無効ならログインの画面に移る", async ({ page }) => {
  // 値は偽物（テスト用ログインの経路は本番のエントリにないため）。届くことだけで SPA を返すことを確かめる。
  // http://localhost には __Host- の Cookie を置けないので、要求のヘッダーで送る
  await page.setExtraHTTPHeaders({ Cookie: "__Host-kh_rt=not-a-real-token" });
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["vary"]).toContain("Cookie");
  expect(await res?.text()).toContain('<div id="root">');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
});

test("紹介のページからホーム画面に追加しても、start_url の / が開く（manifest は SPA と同じ）", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = await (await request.get(href as string)).json();
  expect(manifest).toMatchObject({ start_url: "/", scope: "/", id: "/" });
});
