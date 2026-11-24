import { befriend, expect, friendList, newUser, sheet, test, type E2EUser } from "./fixtures";

// T-20 PC の配置（docs/specs/T-20-desktop-layout.md「E2Eテスト」）：左のナビ・中央のダイアログ・横にスクロールしない・幅を変えても入力が残る
// このファイルは playwright.config.ts の `desktop`（1280×720）でだけ回す

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

/** A から B へ誘いを送る */
async function sendInvite(a: E2EUser, b: E2EUser) {
  await a.page.goto("/friends");
  await friendList(a.page).getByRole("link", { name: b.displayName }).click();
  await sheet(a.page).getByRole("link", { name: "誘う", exact: true }).click();
  const create = sheet(a.page, "誘う");
  await create.getByLabel("日付").fill(tomorrow());
  await create.getByLabel("開始", { exact: true }).fill("10:00");
  await create.getByLabel("終了", { exact: true }).fill("12:00");
  await create.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(a.page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
}

async function expectNoHorizontalScroll(page: E2EUser["page"]) {
  // e2e の tsconfig には DOM の型がないので、globalThis から読む
  type PageGlobal = { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
  const { scrollWidth, innerWidth } = await page.evaluate(() => {
    const g = globalThis as unknown as PageGlobal;
    return { scrollWidth: g.document.documentElement.scrollWidth, innerWidth: g.innerWidth };
  });
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
}

test("左のナビで みんな → ここ暇 → 誘い → 友達 → お知らせ → 設定 と移れ、下のタブと鐘は出ない。どの画面も横にスクロールしない", async ({ loggedInPage: page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "タブ" });
  // ログインの確認中の殻（押せないナビ。docs/specs/T-56-motion.md「M-05」）が、いつものナビに替わるのを待つ
  await expect(nav).not.toHaveAttribute("inert");
  await expect(nav.getByRole("link")).toHaveText(["みんな", "ここ暇", "誘い", "友達", "お知らせ", "設定"]);
  const box = await nav.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.width).toBe(240);

  for (const name of ["ここ暇", "誘い", "友達", "みんな"]) {
    await nav.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(nav.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    await expectNoHorizontalScroll(page);
  }
  // 鐘はナビのお知らせに移す
  await expect(page.getByRole("banner").getByRole("link", { name: /^お知らせ/ })).toHaveCount(0);

  await nav.getByRole("link", { name: /^お知らせ/ }).click();
  await expect(page.getByRole("heading", { name: "お知らせ", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^お知らせ/ })).toHaveAttribute("aria-current", "page");
  await expectNoHorizontalScroll(page);

  await nav.getByRole("link", { name: "設定" }).click();
  await expect(page.getByRole("heading", { name: "設定", level: 1 })).toBeVisible();
  await expect(nav.getByRole("link", { name: "設定" })).toHaveAttribute("aria-current", "page");
  await expectNoHorizontalScroll(page);
});

test("ログイン・プライバシー ポリシー・利用規約の画面は、ナビを出さず横にスクロールしない", async ({ page }) => {
  for (const [path, title] of [
    ["/login", null],
    ["/privacy", "プライバシー ポリシー"],
    ["/terms", "利用規約"],
  ] as const) {
    await page.goto(path);
    if (title) await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    else await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "タブ" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  }
});

test("誘いのカードから詳細が中央のダイアログで開き、Esc で閉じるとカードにフォーカスが戻る。「閉じる」でも閉じる", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await sendInvite(a, b);

  await b.page.goto("/invites");
  const card = b.page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: a.displayName });
  await card.click();
  const detail = sheet(b.page, `${a.displayName}さんからの誘い`);
  await expect(detail).toBeVisible();

  // 画面の中央（左右の余白が同じ・下に付けない）。入る動き（scale(.96) → 1。docs/specs/T-56-motion.md「M-01」）の途中は
  // transform のぶん小さく測れるので、動きが終わってから測る
  await expect.poll(() => detail.evaluate((el) => el.getAnimations().length)).toBe(0);
  const viewport = b.page.viewportSize();
  const box = await detail.boundingBox();
  if (!viewport || !box) throw new Error("サイズが取れない");
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(box.width).toBe(512);
  expect(box.y + box.height).toBeLessThan(viewport.height);
  // つまみは出さず、右上の「閉じる」を使う
  await expect(detail.getByTestId("sheet-grip")).toBeHidden();
  await expect(detail.getByRole("button", { name: "閉じる" })).toBeVisible();

  await b.page.keyboard.press("Escape");
  await expect(sheet(b.page)).toHaveCount(0);
  await expect(b.page).toHaveURL(/\/invites$/);
  await expect(card).toBeFocused();

  await card.click();
  await sheet(b.page).getByRole("button", { name: "閉じる" }).click();
  await expect(sheet(b.page)).toHaveCount(0);
  await expect(b.page).toHaveURL(/\/invites$/);
});

test("誘いの作成のシートに入力したまま幅を390pxと1280pxの間で変えても、入力とシートが残る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await a.page.goto("/friends");
  await friendList(a.page).getByRole("link", { name: b.displayName }).click();
  await sheet(a.page).getByRole("link", { name: "誘う", exact: true }).click();
  const create = sheet(a.page, "誘う");
  await create.getByLabel("日付").fill(tomorrow());
  await create.getByLabel("開始", { exact: true }).fill("10:00");

  await a.page.setViewportSize({ width: 390, height: 844 });
  await expect(create).toBeVisible();
  await expect(create.getByLabel("開始", { exact: true })).toHaveValue("10:00");
  await expect(a.page.getByRole("navigation", { name: "タブ", includeHidden: true }).getByRole("link", { name: "設定", includeHidden: true })).toHaveCount(0);

  await a.page.setViewportSize({ width: 1280, height: 720 });
  await expect(create).toBeVisible();
  await expect(create.getByLabel("日付")).toHaveValue(tomorrow());
  await expect(create.getByLabel("開始", { exact: true })).toHaveValue("10:00");
});

test("PC の幅でも、ログインの確認中に左のナビとヘッダーが出て、確認の前後で位置と大きさが変わらない（docs/specs/T-56-motion.md「M-05」）", async ({ browser }) => {
  const { page } = await newUser(browser, "A");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/auth/refresh", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/friends");
  const header = page.getByRole("banner");
  const nav = page.getByRole("navigation", { name: "タブ" });
  await expect(page.getByRole("heading", { name: "友達", level: 1 })).toBeVisible();
  await expect(nav).toHaveAttribute("inert", "");
  const before = { header: await header.boundingBox(), nav: await nav.boundingBox() };
  release();
  await expect(nav).not.toHaveAttribute("inert");
  await expect(nav.getByRole("link", { name: /^お知らせ/ })).toBeVisible();
  const after = { header: await header.boundingBox(), nav: await nav.boundingBox() };
  expect(before.nav).not.toBeNull();
  expect(after).toEqual(before);
});
