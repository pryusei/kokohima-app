import type { Browser } from "@playwright/test";
import { addAvailability, befriend, expect, loginAs, newUser, test, uniqueName, type E2EUser } from "./fixtures";

// T-07 通知（docs/specs/T-07-notification.md「E2Eテスト」）。メール配信とプッシュは E2E のエントリの偽の実装に向く

const ORIGIN = "http://localhost:5173";
type Sent = { mails: { subject: string; body: string }[]; pushes: { bodyLength: number }[] };

async function token(user: Pick<E2EUser, "context">) {
  const refreshed = await user.context.request.post("/api/v1/auth/refresh", { headers: { Origin: ORIGIN } });
  expect(refreshed.status()).toBe(200);
  return ((await refreshed.json()) as { accessToken: string }).accessToken;
}

async function api(user: Pick<E2EUser, "context">, method: "GET" | "POST", path: string, data?: unknown) {
  const res = await user.context.request.fetch(path, { method, headers: { Authorization: `Bearer ${await token(user)}` }, data });
  expect(res.ok()).toBe(true);
  return res;
}

/** outbox を処理し、その人宛てのお知らせを届ける */
const deliverTo = (user: Pick<E2EUser, "context">) => api(user, "POST", "/__e2e__/outbox/drain");
const sentTo = async (user: Pick<E2EUser, "context">) => (await (await api(user, "GET", "/__e2e__/notifications/sent")).json()) as Sent;
const idOf = async (user: E2EUser) => ((await (await api(user, "GET", "/api/v1/me")).json()) as { id: string }).id;

/** from が to を、明日（Asia/Tokyo）の夜に誘う */
async function invite(from: E2EUser, to: E2EUser) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const at = (hhmm: string) => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
  const res = await api(from, "POST", "/api/v1/direct-invites", { recipientId: await idOf(to), startsAt: at("19:00"), endsAt: at("21:00") });
  return ((await res.json()) as { id: string }).id;
}

async function friends(browser: Browser) {
  const a = await newUser(browser, "A");
  const b = await newUser(browser, "B");
  await befriend(a, b);
  return { a, b };
}

const INVITE_MAIL = /誘いが届きました/;

test("誘いのお知らせ（メール）：未読が出て、一覧から誘いの詳細へ移れる。購読がないのでメールが1通届く", async ({ browser }) => {
  const { a, b } = await friends(browser);
  const inviteId = await invite(a, b);
  await deliverTo(b);

  // お知らせはヘッダーの鐘から開く。未読の数は読み上げの名前に入る（docs/specs/T-11-design.md）
  await b.page.goto("/");
  const bell = b.page.getByRole("link", { name: /^お知らせ \d+件の未読$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  await b.page.getByRole("link", { name: `${a.displayName}さんから誘いが届きました` }).click();
  await expect(b.page).toHaveURL(new RegExp(`/invites/${inviteId}$`));

  const sent = await sentTo(b);
  const mails = sent.mails.filter((m) => INVITE_MAIL.test(m.body));
  expect(mails).toHaveLength(1);
  expect(mails[0]?.subject).toBe("ここ暇：新しいお知らせがあります");
  // 相手の名前はメールに入らない
  expect(mails[0]?.body).not.toContain(a.displayName);
  expect(sent.pushes).toHaveLength(0);
});

test("誘いのお知らせ（プッシュ）：購読があれば、本文なしのプッシュが1件で、メールは届かない", async ({ browser }) => {
  const { a, b: c } = await friends(browser);
  await deliverTo(c);
  await api(c, "POST", "/api/v1/push/subscriptions", { endpoint: `https://push.e2e.invalid/send/${crypto.randomUUID()}` });
  await invite(a, c);
  await deliverTo(c);

  const sent = await sentTo(c);
  expect(sent.pushes).toEqual([{ bodyLength: 0 }]);
  expect(sent.mails.filter((m) => INVITE_MAIL.test(m.body))).toHaveLength(0);
});

test("友達追加と「見せない」：お知らせ一覧の「この人に見せない」で、相手の「みんな」から自分のここ暇が消える", async ({ browser }) => {
  const { a, b } = await friends(browser);
  // 夜の枠が過去にならないよう、日付は明日（Asia/Tokyo）を使う（今日だと 23 時以降に作れない）
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
  await addAvailability(a.page, tomorrow, "夜");
  await expect(a.page.getByRole("list", { name: "自分のここ暇" }).getByText(/夜 19:00〜23:00/)).toBeVisible();
  await b.page.goto("/");
  await expect(b.page.getByRole("listitem").filter({ hasText: a.displayName }).first()).toBeVisible();

  await deliverTo(a);
  await a.page.goto("/notifications");
  const item = a.page.getByRole("listitem").filter({ hasText: `${b.displayName}さんと友達になりました` });
  await item.getByRole("button", { name: "この人に見せない" }).click();
  await expect(item.getByText("見せないにしました")).toBeVisible();

  await b.page.goto("/");
  await expect(b.page.getByRole("heading", { name: "みんな" })).toBeVisible();
  await expect(b.page.getByRole("listitem").filter({ hasText: a.displayName })).toHaveCount(0);
});

test("種別を止める：「誘い」を止めると、お知らせ一覧には出るがメールは届かない", async ({ browser }) => {
  const { a, b } = await friends(browser);
  await b.page.goto("/friends");
  await b.page.getByRole("link", { name: /設定/ }).click();
  await b.page.getByRole("link", { name: /通知の設定/ }).click();
  const invites = b.page.getByRole("switch", { name: "誘い" });
  await expect(invites).toBeChecked();
  await invites.click();
  await expect(invites).not.toBeChecked();
  await b.page.reload();
  await expect(b.page.getByRole("switch", { name: "誘い" })).not.toBeChecked();

  await invite(a, b);
  await deliverTo(b);
  await b.page.goto("/notifications");
  await expect(b.page.getByRole("link", { name: `${a.displayName}さんから誘いが届きました` })).toBeVisible();
  expect((await sentTo(b)).mails.filter((m) => INVITE_MAIL.test(m.body))).toHaveLength(0);
});

test("新端末のログイン：2つめのセッションで、新しい端末でのログインのメールが届く", async ({ browser }) => {
  const first = await browser.newContext();
  const user = await loginAs(first, "b", uniqueName("B"));
  await deliverTo({ context: first });
  expect((await sentTo({ context: first })).mails).toHaveLength(0);

  const second = await browser.newContext();
  expect((await second.request.post("/__e2e__/login", { data: { user } })).status()).toBe(204);
  await deliverTo({ context: second });
  const sent = await sentTo({ context: second });
  expect(sent.mails.map((m) => m.subject)).toEqual(["ここ暇：新しい端末でログインがありました"]);
  expect(sent.pushes).toHaveLength(0);
});
