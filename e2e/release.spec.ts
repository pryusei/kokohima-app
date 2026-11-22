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

// /invite は未ログインでも InvitePage を描画する（トークンがないので「使えません」）。ほかは未ログインなのでログインの画面
const pages: { path: string; rendered: (page: Page) => ReturnType<Page["getByRole"]> }[] = [
  { path: "/login", rendered: (page) => page.getByRole("link", { name: "Googleでログイン" }) },
  { path: "/invites/00000000-0000-4000-8000-000000000000", rendered: (page) => page.getByRole("link", { name: "Googleでログイン" }) },
  { path: "/invite", rendered: (page) => page.getByRole("status").filter({ hasText: "このリンクは使えません" }) },
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

test("本番と同じ形では、画面の側の POST は405で、テスト用ログインの経路はない", async ({ request }) => {
  const post = await request.post("/__e2e__/login", { data: {} });
  expect(post.status()).toBe(405);
  const api = await request.get("/api/v1/health");
  expect(api.status()).toBe(200);
  expect(api.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
});
