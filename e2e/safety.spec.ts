import type { BrowserContext, Page } from "@playwright/test";
import { befriend, createInviteUrl, expect, friendList, newUser, sheet, test, type E2EUser } from "./fixtures";

// T-33 ブロックと通報（docs/specs/T-33-block-report.md「E2Eテスト」）。Slack は E2E のエントリの偽物（slack.e2e.invalid）に向く。
// E2E では API の始める日を 0 に、画面の __SAFETY_FORCE_OPEN__ を true にして、始める日によらずに回す

type Posts = { posts: { text: string }[] };

/** 閲覧者として API を呼ぶ（Origin は、そのプロジェクトの画面に合わせる） */
async function api(context: BrowserContext, method: "GET" | "POST", path: string, data?: unknown) {
  const origin = test.info().project.use.baseURL ?? "http://localhost:5173";
  const refreshed = await context.request.post("/api/v1/auth/refresh", { headers: { Origin: origin } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await context.request.fetch(path, { method, headers: { Authorization: `Bearer ${accessToken}`, Origin: origin }, data });
  expect(res.ok()).toBe(true);
  return res;
}

function tomorrow() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
}

async function openFriend(page: Page, friend: E2EUser) {
  await page.goto("/friends");
  await friendList(page).getByRole("link", { name: friend.displayName }).click();
  await page.getByRole("button", { name: `${friend.displayName}さんへの操作` }).click();
}

test("AがBをブロックすると、双方の友達一覧から消え、BがAの新しい招待リンクを開いても「このリンクは使えません」。設定でやめても友達には戻らない", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);

  await openFriend(a.page, b);
  await expect(sheet(a.page).getByText(`どれを選んでも${b.displayName}さんには知らせません。`)).toBeVisible();
  await a.page.getByRole("button", { name: "ブロック", exact: true }).click();
  await a.page.getByRole("button", { name: `${b.displayName}さんをブロックする` }).click();
  await expect(a.page.getByText("ブロックしました。")).toBeVisible();
  await a.page.getByRole("button", { name: "戻る" }).click();
  await expect(a.page).toHaveURL(/\/friends$/);
  await expect(a.page.getByText("まだ友達はいません")).toBeVisible();

  await b.page.goto("/friends");
  await expect(b.page.getByText("まだ友達はいません")).toBeVisible();

  // ブロックしている間は、A の新しいリンクを B が開いても、期限切れ・取り消しと同じ表示
  const url = await createInviteUrl(a.page);
  await b.page.goto(url);
  await expect(b.page.getByText(/このリンクは使えません/)).toBeVisible();
  await expect(b.page.getByRole("button", { name: "友達になる" })).toHaveCount(0);

  // 設定の「ブロックした人」からやめる。友達には戻らない
  await a.page.goto("/settings");
  await a.page.getByRole("link", { name: /ブロックした人/ }).click();
  const list = a.page.getByRole("list", { name: "ブロックした人" });
  await list.getByRole("button", { name: `${b.displayName}のブロックをやめる` }).click();
  await expect(a.page.getByText("ブロックした人はいません")).toBeVisible();
  await a.page.goto("/friends");
  await expect(a.page.getByText("まだ友達はいません")).toBeVisible();
});

test("Bから届いた誘いを、Aが「…」から通報する（ブロックもする）→ 静かに「送りました。ブロックもしました。」→ 偽の Slack に誘いのひとことと一緒に1通届く", async ({ browser }) => {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);

  // B が A を誘う（ひとこと付き）
  const marker = crypto.randomUUID().slice(0, 8);
  const ids = (await (await api(b.context, "GET", "/api/v1/friends")).json()) as { items: { id: string; displayName: string }[] };
  const aId = ids.items.find((f) => f.displayName === a.displayName)?.id;
  const date = tomorrow();
  await api(b.context, "POST", "/api/v1/direct-invites", {
    recipientId: aId,
    startsAt: new Date(`${date}T10:00:00+09:00`).toISOString(),
    endsAt: new Date(`${date}T12:00:00+09:00`).toISOString(),
    message: `ひとこと ${marker}`,
  });

  await a.page.goto("/invites?tab=received");
  await a.page.getByRole("list", { name: "受信した誘い" }).getByRole("link").filter({ hasText: b.displayName }).click();
  await a.page.getByRole("button", { name: `${b.displayName}さんへの操作` }).click();
  await a.page.getByRole("button", { name: "通報" }).click();
  await expect(a.page.getByText("危ないと感じたら、周りの大人か #9110 へ。急ぐときは110番")).toBeVisible();
  await expect(a.page.getByRole("checkbox", { name: "ブロックもする" })).toBeChecked();
  await a.page.getByRole("button", { name: "会うのが不安な誘い" }).click();
  await a.page.getByRole("button", { name: "運営に送る" }).click();
  await expect(a.page.getByText("送りました。ブロックもしました。")).toBeVisible();

  await api(a.context, "POST", "/__e2e__/outbox/drain");
  const { posts } = (await (await api(a.context, "GET", "/__e2e__/contact/posts")).json()) as Posts;
  expect(posts).toHaveLength(1);
  expect(posts[0]?.text).toBe("通報：会うのが不安な誘い");
  expect(JSON.stringify(posts[0])).toContain(`ひとこと ${marker}`);

  // ブロックもしたので、双方の友達一覧から消える。B には何も届かない（お知らせなし）
  await a.page.goto("/friends");
  await expect(a.page.getByText("まだ友達はいません")).toBeVisible();
  await b.page.goto("/notifications");
  await expect(b.page.getByText(/通報|ブロック/)).toHaveCount(0);
});
