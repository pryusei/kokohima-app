import { befriend, expect, newUser, sheet, test } from "./fixtures";

// T-22 行きたいリスト（docs/specs/T-22-wishlist.md「E2Eテスト」）

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

test("Aが行きたいを置く（Cを外す）→ Bの「みんな」に出てCには出ない → Bが「ここで誘う」→ 宛先がAで、ひとこととリンク入りの誘いを送れる", async ({
  browser,
}) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  const c = await newUser(browser, "C");
  await befriend(a, b);
  await befriend(a, c);
  const message = `ラーメン行きたい ${crypto.randomUUID().slice(0, 4)}`;

  await a.page.goto("/availability");
  await a.page.getByRole("button", { name: "＋ 行きたいを置く" }).click();
  const add = sheet(a.page, "行きたいを置く");
  await add.getByLabel("ひとこと").fill(message);
  await add.getByLabel("リンク（任意）").fill("https://ramen.example.com/shop");
  await add.getByRole("button", { name: "外す人を選ぶ" }).click();
  await add.getByRole("checkbox", { name: c.displayName }).uncheck();
  await add.getByRole("button", { name: "置く", exact: true }).click();
  await expect(a.page.getByRole("list", { name: "自分の行きたい" }).getByText(message)).toBeVisible();

  // 外された C の「みんな」には出ない（友達の行きたいの応答を受け取ってから確かめる）
  const loaded = c.page.waitForResponse((r) => r.url().includes("/api/v1/friend-wishes") && r.ok());
  await c.page.goto("/");
  await loaded;
  await expect(c.page.getByRole("list", { name: "友達の行きたい" })).toHaveCount(0);
  await expect(c.page.getByText(message)).toHaveCount(0);

  await b.page.goto("/");
  const friendWishes = b.page.getByRole("list", { name: "友達の行きたい" });
  await expect(friendWishes.getByText(message)).toBeVisible();
  await friendWishes.getByRole("link", { name: "ここで誘う" }).click();

  await expect(b.page.getByLabel("ひとこと（任意）")).toHaveValue(message);
  await expect(b.page.getByLabel("リンク（任意）")).toHaveValue("https://ramen.example.com/shop");
  await expect(b.page.getByLabel("相手")).toHaveValue(/.+/);
  await expect(b.page.getByLabel("相手").locator("option:checked")).toHaveText(a.displayName);
  await b.page.getByLabel("日付").fill(tomorrow());
  await b.page.getByLabel("開始", { exact: true }).fill("12:00");
  await b.page.getByLabel("終了", { exact: true }).fill("14:00");
  await b.page.getByRole("button", { name: "誘う", exact: true }).click();
  await expect(b.page).toHaveURL(/\/invites\/[0-9a-f-]+$/);
  await expect(sheet(b.page).getByText(message)).toBeVisible();
});

// T-29 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md「E2Eテスト」）。Claude は偽の実装（apps/api/src/e2e/claude.ts）
test("「AIでお店を探す」→ 候補が出る（検索の結果にない URL の候補は出ない）→「行きたいに置く」→ 値が入った置くシートから置ける", async ({
  browser,
}) => {
  const a = await newUser(browser, "A");
  await a.page.goto("/availability");
  await a.page.getByRole("button", { name: "AIでお店を探す" }).click();
  const search = sheet(a.page, "行きたいを探す");
  await search.getByLabel("どのあたり？").fill("渋谷");
  await search.getByLabel("何をしたい？").fill("ラーメン");
  await expect(search.getByText("今日はあと5回探せます")).toBeVisible();
  await search.getByRole("button", { name: "候補を探す" }).click();

  const list = search.getByRole("list", { name: "候補" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByText("幻の店")).toHaveCount(0);
  await expect(list.getByText("駅から3分")).toBeVisible();
  await list.getByRole("button", { name: "行きたいに置く" }).first().click();

  const add = sheet(a.page, "行きたいを置く");
  await expect(add.getByText("候補から入れました。直してから置けます。")).toBeVisible();
  await expect(add.getByLabel("ひとこと")).toHaveValue("E2E のお店のつけ麺行きたい");
  await expect(add.getByLabel("リンク（任意）")).toHaveValue("https://ogp.e2e.invalid/page");
  // エリアは候補の店の場所（AI が出した最寄り駅）。探したときのエリア（渋谷）ではない
  await expect(add.getByLabel("エリア（任意）")).toHaveValue("渋谷駅");
  await add.getByRole("button", { name: "置く", exact: true }).click();
  await expect(a.page.getByRole("list", { name: "自分の行きたい" }).getByText("E2E のお店のつけ麺行きたい")).toBeVisible();
});

test("見つからない言葉で探すと、静かな「候補が見つかりませんでした」が出て、探せる回数が減らない", async ({ browser }) => {
  const a = await newUser(browser, "A");
  await a.page.goto("/availability");
  await a.page.getByRole("button", { name: "AIでお店を探す" }).click();
  const search = sheet(a.page, "行きたいを探す");
  await search.getByLabel("どのあたり？").fill("湘南");
  await search.getByLabel("何をしたい？").fill("__empty__");
  await search.getByRole("button", { name: "候補を探す" }).click();
  await expect(search.getByText("候補が見つかりませんでした")).toBeVisible();
  await search.getByRole("button", { name: "言葉を変えて探す" }).click();
  await expect(search.getByText("今日はあと5回探せます")).toBeVisible();
});
