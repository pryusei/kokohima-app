import { befriend, expect, friendList, newUser, sheet, test } from "./fixtures";

// T-11 画面のつながり（docs/specs/T-11-design.md「E2Eテスト」）：下のタブ・ヘッダーの鐘・シート

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

test("下のタブで みんな → ここ暇 → 誘い → 友達 と移れ、ヘッダーの鐘からお知らせが開ける", { tag: "@iphone" }, async ({ loggedInPage: page }) => {
  await page.goto("/");
  const tabs = page.getByRole("navigation", { name: "タブ" });
  await expect(tabs.getByRole("link")).toHaveText(["みんな", "ここ暇", "誘い", "友達"]);
  for (const name of ["ここ暇", "誘い", "友達", "みんな"]) {
    await tabs.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(tabs.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("link", { name: /^お知らせ/ }).click();
  await expect(page.getByRole("heading", { name: "お知らせ", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(page.getByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
});

test("スマホの幅で、みんなタブから開いた募集の作成のシートを「閉じる」のボタンで閉じると、みんなタブに戻り、開いたボタンにフォーカスが戻る", { tag: "@iphone" }, async ({ browser }) => {
  // 募るボタンは友達がいるときだけ出る（友達0人は招待のボタンだけ。docs/specs/T-34-kokodou-entry.md）
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(b, a);
  const page = a.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("link", { name: "暇な人いる？と募る" }).click();
  const create = sheet(page, "暇な人いる？と募る");
  await expect(create).toBeVisible();
  // 入力欄がシートの幅をはみ出さない（横にスクロールせず、日付・開始・終了の右端がシートの右端を越えない）。
  // iPhone の Safari の日付の入力欄で起きるはみ出しは、Chromium でも Linux の WebKit（iphone のプロジェクト）でも再現しないので、
  // その後戻りは単体テスト（apps/web/src/ui/form.test.ts）で守る（docs/specs/T-21-webkit-e2e.md）
  const dialog = await create.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(dialog.scroll).toBeLessThanOrEqual(dialog.client);
  const sheetBox = await create.boundingBox();
  for (const label of ["日付", "開始", "終了"]) {
    const box = await create.getByLabel(label, { exact: true }).boundingBox();
    expect(box && sheetBox && box.x + box.width, `${label}の入力欄の右端`).toBeLessThanOrEqual((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0));
  }
  await create.getByRole("button", { name: "閉じる" }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "暇な人いる？と募る" })).toBeFocused();
});

test("誘いの一覧のカードから詳細がシートで開き、「行く」のあとシートを閉じると誘いタブに戻る", { tag: "@iphone" }, async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);

  await a.page.goto("/friends");
  await friendList(a.page).getByRole("link", { name: b.displayName }).click();
  await sheet(a.page).getByRole("link", { name: "誘う", exact: true }).click();
  const create = sheet(a.page, "誘う");
  await create.getByLabel("日付").fill(tomorrow());
  await create.getByLabel("開始", { exact: true }).fill("10:00");
  await create.getByLabel("終了", { exact: true }).fill("12:00");
  await create.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(sheet(a.page).getByText("返事待ち")).toBeVisible();

  await b.page.goto("/invites");
  await b.page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: a.displayName }).click();
  const detail = sheet(b.page, `${a.displayName}さんからの誘い`);
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: "行く" }).click();
  await expect(detail.getByText("成立", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "閉じる" }).click();
  await expect(sheet(b.page)).toHaveCount(0);
  await expect(b.page).toHaveURL(/\/invites$/);
  await expect(b.page.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
});

test("お知らせのリンクのように誘いの URL を直接開いて閉じると、アプリの外に出ず誘いタブへ移る", { tag: "@iphone" }, async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  await a.page.goto("/friends");
  await friendList(a.page).getByRole("link", { name: b.displayName }).click();
  await sheet(a.page).getByRole("link", { name: "誘う", exact: true }).click();
  const create = sheet(a.page, "誘う");
  await create.getByLabel("日付").fill(tomorrow());
  await create.getByLabel("開始", { exact: true }).fill("10:00");
  await create.getByLabel("終了", { exact: true }).fill("12:00");
  await create.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(a.page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
  const inviteUrl = a.page.url();

  await b.page.goto(inviteUrl);
  await expect(sheet(b.page)).toBeVisible();
  // 見えただけでは、まだ Esc を受けられないことがある（WebKit。シートにフォーカスを移すのと Esc を受ける処理を付けるのは、同じ effect の中）。
  // フォーカスが入ったのを待ってから押す（docs/specs/T-30-ci-review.md「5. flaky の修正」）
  await expect(sheet(b.page)).toBeFocused();
  await b.page.keyboard.press("Escape");
  await expect(b.page).toHaveURL(/\/invites$/);
  await expect(b.page.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
});

test("動きを止めない設定でも、シートは閉じる動きのあとに消え、開いたボタンにフォーカスが戻る（docs/specs/T-56-motion.md「M-01」）", async ({ browser }) => {
  const { page } = await newUser(browser, "A");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/friends");
  expect(await page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')).toBe(false);
  const opener = page.getByRole("button", { name: "招待リンクを作る" });
  await opener.click();
  const dialog = sheet(page, "招待リンクを作る");
  await expect(dialog).toBeFocused();
  // 「閉じる」を押した20ms後には、まだシートがある（出る動きの途中。即時に消えていない）
  const stillThere = await dialog.evaluate(
    (el) =>
      new Promise<boolean>((resolve) => {
        (el.querySelector('button[aria-label="閉じる"]') as { click(): void } | null)?.click();
        setTimeout(() => resolve(el.isConnected), 20);
      }),
  );
  expect(stillThere).toBe(true);
  await expect(sheet(page)).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("みんなタブを下へスクロールして誘いタブへ移り、みんなタブに戻ると位置が戻る。今いるタブを押すと一番上に戻る（docs/specs/T-56-motion.md「M-07」）", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(b, a);
  const page = a.page;
  // 中身がスクロールできる高さにする
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "誰を誘う？" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "タブ" });
  await expect(tabs).not.toHaveAttribute("inert");
  await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  const scrolled = Number(await page.evaluate("window.scrollY"));
  expect(scrolled).toBeGreaterThan(0);

  await tabs.getByRole("link", { name: "誘い" }).click();
  await expect(page.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
  // 初めてのタブは一番上から
  await expect.poll(async () => Number(await page.evaluate("window.scrollY"))).toBe(0);

  await tabs.getByRole("link", { name: "みんな" }).click();
  await expect(page.getByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
  await expect.poll(async () => Number(await page.evaluate("window.scrollY"))).toBe(scrolled);

  // 今いるタブをもう一度押すと一番上へ。URL は変えない
  await tabs.getByRole("link", { name: "みんな" }).click();
  await expect.poll(async () => Number(await page.evaluate("window.scrollY"))).toBe(0);
  await expect(page).toHaveURL(/\/$/);
});

test("ログインの確認中もヘッダーと下のタブが出て、確認の前後で位置と大きさが変わらない（docs/specs/T-56-motion.md「M-05」）", async ({ browser }) => {
  const { page } = await newUser(browser, "A");
  await page.setViewportSize({ width: 390, height: 844 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/auth/refresh", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/invites");
  const header = page.getByRole("banner");
  const tabs = page.getByRole("navigation", { name: "タブ" });
  await expect(page.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
  await expect(tabs).toHaveAttribute("inert", "");
  await expect(page.getByRole("status", { name: "読み込み中" })).toBeAttached();
  const before = { header: await header.boundingBox(), tabs: await tabs.boundingBox() };
  release();
  await expect(tabs).not.toHaveAttribute("inert");
  await expect(page.getByRole("link", { name: /^お知らせ/ })).toBeVisible();
  const after = { header: await header.boundingBox(), tabs: await tabs.boundingBox() };
  expect(before.header).not.toBeNull();
  expect(after).toEqual(before);
});
