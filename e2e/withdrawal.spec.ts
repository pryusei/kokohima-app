import type { BrowserContext } from "@playwright/test";
import { befriend, expect, friendList, loginAs, newUser, sheet, test, uniqueName } from "./fixtures";

// T-16 退会（docs/specs/T-16-withdrawal.md「E2Eテスト」）

const ORIGIN = "http://localhost:5173";

async function api(context: BrowserContext, method: "GET" | "POST", path: string, data?: unknown) {
  const refreshed = await context.request.post("/api/v1/auth/refresh", { headers: { Origin: ORIGIN } });
  expect(refreshed.status()).toBe(200);
  const { accessToken } = (await refreshed.json()) as { accessToken: string };
  const res = await context.request.fetch(path, { method, headers: { Authorization: `Bearer ${accessToken}` }, data });
  expect(res.ok()).toBe(true);
  return res;
}

const idOf = async (context: BrowserContext) => ((await (await api(context, "GET", "/api/v1/me")).json()) as { id: string }).id;

/** 明日（Asia/Tokyo）の時刻 */
function tomorrow(hhmm: string) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  return new Date(`${date}T${hhmm}:00+09:00`).toISOString();
}

test("設定から退会すると、相手の予定は「やっぱり難しい」になり、相手には「退会したユーザー」と出る", async ({ browser }) => {
  const aContext = await browser.newContext();
  const aName = uniqueName("A");
  const aUser = await loginAs(aContext, "w", aName);
  const a = { context: aContext, page: await aContext.newPage(), displayName: aName };
  const b = await newUser(browser, "B");
  await befriend(a, b);
  const aId = await idOf(a.context);

  // 成立した予定（B が誘い、A が「行く」）と、A への返事待ちの誘い
  const invited = await api(b.context, "POST", "/api/v1/direct-invites", { recipientId: aId, startsAt: tomorrow("19:00"), endsAt: tomorrow("21:00") });
  const inviteId = ((await invited.json()) as { id: string }).id;
  const accepted = await api(a.context, "POST", `/api/v1/direct-invites/${inviteId}/responses`, { response: "accept" });
  const meetupId = ((await accepted.json()) as { meetupId: string }).meetupId;
  await api(b.context, "POST", "/api/v1/direct-invites", { recipientId: aId, startsAt: tomorrow("12:00"), endsAt: tomorrow("13:00") });

  // 直前にログインし直してから、設定のアカウントで退会する
  const relogin = await a.context.request.post("/__e2e__/login", { data: { user: aUser } });
  expect(relogin.status()).toBe(204);
  await a.page.goto("/settings/account");
  await a.page.getByRole("button", { name: "退会する" }).click();
  const confirm = sheet(a.page, "退会の確認");
  await expect(confirm.getByText("取り消せません", { exact: false })).toBeVisible();
  await confirm.getByRole("button", { name: "退会する" }).click();
  await expect(a.page).toHaveURL(/\/login\?withdrawn=1$/);
  await expect(a.page.getByText("退会しました。")).toBeVisible();

  // 後始末の段を流す（B の要求で outbox を処理する）
  await api(b.context, "POST", "/__e2e__/outbox/drain");

  await b.page.goto(`/meetups/${meetupId}`);
  await expect(b.page.getByText("やっぱり難しくなりました")).toBeVisible();
  await expect(b.page.getByText("退会したユーザー")).toBeVisible();

  await b.page.goto("/notifications");
  await expect(b.page.getByRole("link", { name: "退会したユーザーは今回は難しいみたい" })).toBeVisible();

  await b.page.goto("/friends");
  await expect(friendList(b.page).getByText(a.displayName)).toHaveCount(0);
});
