import { createInviteUrl, expect, friendList, loginAs, newUser, sheet, test, uniqueName } from "./fixtures";

// T-02 友達と招待リンク（docs/specs/T-02-friends.md「E2Eテスト」）
// 相手を見分けるため、テスト用ユーザーに一意な表示名を付ける

test("友達が0人なら「みんな」は「友達を招待する」の1つのボタンだけで、押すと招待リンクの発行のシートが開く", async ({ browser }) => {
  // docs/specs/T-34-kokodou-entry.md「E2Eテスト」。招待リンクを作れるよう、表示名つきのユーザーにする
  const { page } = await newUser(browser, "A");
  await page.goto("/");
  await expect(page.getByText("まだ友達はいません")).toBeVisible();
  await expect(page.getByRole("link", { name: "暇な人いる？と募る" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "誰を誘う？" })).toHaveCount(0);
  await page.getByRole("button", { name: "友達を招待する" }).click();
  const dialog = sheet(page, "招待リンクを作る");
  await dialog.getByRole("button", { name: "招待リンクを作る" }).click();
  await expect(dialog.getByLabel("招待リンクのURL")).toHaveValue(/\/invite#t=/);
});

test("リンクを開いて「友達になる」と、双方の友達一覧に相手が出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);

  await b.page.goto(url);
  await expect(b.page.getByText(a.displayName)).toBeVisible();
  await b.page.getByRole("button", { name: "友達になる" }).click();
  await expect(b.page).toHaveURL(/\/friends$/);
  await expect(friendList(b.page).getByText(a.displayName)).toBeVisible();

  await a.page.reload();
  await expect(friendList(a.page).getByText(b.displayName)).toBeVisible();
});

test("未ログインでリンクを開くとログインを求められ、ログイン後に /invite を開くと友達になれる", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const url = await createInviteUrl(a.page);

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByText(a.displayName)).toBeVisible();
  await expect(page.getByRole("link", { name: "Googleでログイン" })).toBeVisible();
  // URLからトークンが消えている
  expect(new URL(page.url()).hash).toBe("");

  // 同じブラウザでログインする（招待Cookieが残っている）
  await loginAs(context, "c", uniqueName("C"));
  await page.goto("/invite");
  await expect(page.getByText(a.displayName)).toBeVisible();
  await page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(page).getByText(a.displayName)).toBeVisible();
});

test("無効化したリンクを開くと「このリンクは使えません」が表示される", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);
  // 作ったリンクは友達タブの「有効な招待リンク」から無効にする
  await a.page.keyboard.press("Escape");
  await a.page.getByRole("button", { name: "無効にする" }).click();
  await expect(a.page.getByRole("button", { name: "無効にする" })).toHaveCount(0);

  await b.page.goto(url);
  await expect(b.page.getByText(/このリンクは使えません/)).toBeVisible();
  await expect(b.page.getByRole("button", { name: "友達になる" })).toHaveCount(0);
});

test("友達を解除すると、双方の一覧から消える", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const url = await createInviteUrl(a.page);
  await b.page.goto(url);
  await b.page.getByRole("button", { name: "友達になる" }).click();
  await expect(friendList(b.page).getByText(a.displayName)).toBeVisible();

  // 解除は友達の詳細（シート）から。確認は1回だけ
  await a.page.goto("/friends");
  await friendList(a.page).getByRole("link", { name: b.displayName }).click();
  await a.page.getByRole("button", { name: "友達を解除" }).click();
  await a.page.getByRole("button", { name: `${b.displayName}さんとの友達を解除する` }).click();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(a.page.getByText("まだ友達はいません")).toBeVisible();

  await b.page.reload();
  await expect(b.page.getByText("まだ友達はいません")).toBeVisible();
});

// T-28 LINEで送る（docs/specs/T-28-line-share.md「E2Eテスト」）
test("招待リンクの「LINEで送る」は、openExternalBrowser 付きの招待リンクを本文に持つ（LINEは開かない）", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const url = await createInviteUrl(a.page);

  const href = (await a.page.getByRole("link", { name: "LINEで送る" }).getAttribute("href")) ?? "";
  const prefix = "https://line.me/R/share?text=";
  expect(href.startsWith(prefix)).toBe(true);
  const [, shared] = decodeURIComponent(href.slice(prefix.length)).split("\n");
  const expected = new URL(url);
  expected.searchParams.set("openExternalBrowser", "1");
  expect(shared).toBe(expected.toString());
});

test("LINEのアプリ内ブラウザで招待リンクを開くと、発行者の名前と「ブラウザで開き直す」が出る", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const url = await createInviteUrl(a.page);
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get("t");

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.2.0",
  });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByText(a.displayName)).toBeVisible();
  await expect(page.getByRole("link", { name: "ブラウザで開き直す" })).toHaveAttribute(
    "href",
    `/invite?openExternalBrowser=1#t=${token}`,
  );
  // URLからはトークンが消えている
  expect(new URL(page.url()).hash).toBe("");
  await context.close();
});
