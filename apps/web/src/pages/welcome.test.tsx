import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 名前の画面と、友達になった直後の1画面（docs/specs/T-31-display-name-first-step.md）

const ME_ID = "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11";
const me = (displayName: string | null) => ({ id: ME_ID, displayName, avatarUrl: null });
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const problem = (status: number, code: string) => json({ type: "about:blank", title: "x", status, code, requestId: "r" }, status);
const created = (date: string) =>
  json(
    {
      id: "44444444-4444-4444-8444-444444444444",
      startsAt: `${date}T10:00:00.000Z`,
      endsAt: `${date}T14:00:00.000Z`,
      label: "night",
      source: "manual",
      date: null,
    },
    201,
  );

/** 説明の文（ui/feedback の Note）の数。操作の結果（role="status"）は数えない */
const notes = () => screen.getAllByText((_, el) => el?.tagName === "P" && el.className === "text-s text-ink-muted" && !el.getAttribute("role"));

beforeEach(() => {
  tokenStore.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  // 2026-10-10 09:00（日本時間）
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

/** プッシュが使えるブラウザのふり（notifications.test.tsx と同じ形） */
function stubPush(opts: { permission?: NotificationPermission; endpoint?: string | null; grant?: NotificationPermission } = {}) {
  const endpoint = opts.endpoint === undefined ? "https://fcm.googleapis.com/fcm/send/abc" : opts.endpoint;
  let current = endpoint ? { endpoint, unsubscribe: vi.fn(async () => true) } : null;
  const subscribe = vi.fn(async () => (current = { endpoint: "https://fcm.googleapis.com/fcm/send/new", unsubscribe: vi.fn(async () => true) }));
  const registration = { pushManager: { getSubscription: async () => current, subscribe } };
  const requestPermission = vi.fn(async () => opts.grant ?? ("granted" as NotificationPermission));
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: opts.permission ?? "default", requestPermission });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => registration), getRegistration: async () => registration, ready: Promise.resolve(registration) },
  });
  return { subscribe, requestPermission };
}

describe("名前の画面（招待を経由しないとき）", () => {
  const availabilityTab = {
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/notifications/unread-count": json({ count: 0 }),
    "/api/v1/availabilities": empty,
    "/api/v1/recurrence-rules": empty,
    "/api/v1/me/presets": presets,
    "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    "/api/v1/wishes": empty,
  };

  it("名前がなければ、開こうとした画面の代わりに名前の画面を出し、保存するとその画面が出る（URL は変わらない）", async () => {
    window.history.replaceState(null, "", "/availability");
    const { calls } = mockFetch({ ...availabilityTab, "/api/v1/me": [json(me(null)), json(me("ゆう"))] });
    renderApp();
    expect(await screen.findByRole("heading", { name: "表示名を決めてください" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "タブ" })).toBeNull();
    // 説明の文は1行だけ
    expect(notes()).toHaveLength(1);
    const button = screen.getByRole("button", { name: "これで始める" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("表示名"), "ゆう");
    await userEvent.click(button);
    expect(await screen.findByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
    expect(window.location.pathname).toBe("/availability");
    const patch = calls.find((c) => c.url === "/api/v1/me" && c.init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ displayName: "ゆう" });
  });

  it("保存できなければ、静かな文言を出して名前の画面に留まる", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": [json(me(null)), problem(400, "validation_failed")],
    });
    renderApp();
    await userEvent.type(await screen.findByLabelText("表示名"), "ゆう");
    await userEvent.click(screen.getByRole("button", { name: "これで始める" }));
    const text = await screen.findByText("保存できませんでした。1〜20文字で入力してください。");
    expect(text.className).not.toMatch(/red|rose|error/);
    expect(screen.getByRole("heading", { name: "表示名を決めてください" })).toBeVisible();
  });

  it("名前の画面からログアウトできる", async () => {
    window.history.replaceState(null, "", "/");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me(null)),
      "/api/v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
  });

  it("GET /me が読めなければ、名前の画面で止めずにいつもの画面を出す", async () => {
    window.history.replaceState(null, "", "/availability");
    mockFetch({ ...availabilityTab, "/api/v1/me": problem(500, "internal") });
    renderApp();
    expect(await screen.findByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "表示名を決めてください" })).toBeNull();
  });

  it("名前があれば名前の画面を出さない", async () => {
    window.history.replaceState(null, "", "/availability");
    mockFetch({ ...availabilityTab, "/api/v1/me": json(me("ゆう")) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "ここ暇", level: 1 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "表示名を決めてください" })).toBeNull();
  });
});

describe("友達になった直後の1画面（/welcome）", () => {
  const welcome = (routes: Parameters<typeof mockFetch>[0] = {}) => {
    window.history.replaceState(null, "", "/welcome");
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me("ゆう")),
      "/api/v1/me/presets": presets,
      ...routes,
    });
  };

  it("説明の文は1行だけ。カレンダー連携の案内は出さない", async () => {
    welcome();
    renderApp();
    expect(await screen.findByRole("heading", { name: "友達になりました" })).toBeVisible();
    await screen.findByRole("heading", { name: "今日のここ暇を1つ出す" });
    expect(notes()).toHaveLength(1);
    expect(screen.queryByText(/カレンダー/)).toBeNull();
  });

  it("チップを押すと、今日のそのプリセットでここ暇を1つ作り（Idempotency-Key つき）、「出しました」と出して押せなくする", async () => {
    const { calls } = welcome({ "/api/v1/availabilities": created("2026-10-10") });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "今日のここ暇を1つ出す" })).closest("section") as HTMLElement;
    await userEvent.click(within(section).getByRole("button", { name: /^夜/ }));
    expect(await screen.findByText("出しました")).toBeVisible();
    const post = calls.find((c) => c.url === "/api/v1/availabilities");
    expect(JSON.parse(String(post?.init.body))).toEqual({ date: "2026-10-10", preset: "night" });
    expect(new Headers(post?.init.headers).get("Idempotency-Key")).toBeTruthy();
    for (const b of within(section).getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("今日のうち終わったプリセットは押せない", async () => {
    // 16:00（日本時間）：昼（〜15:00）は終わっている
    vi.setSystemTime(new Date("2026-10-10T07:00:00Z"));
    welcome();
    renderApp();
    await screen.findByRole("heading", { name: "今日のここ暇を1つ出す" });
    expect(screen.getByRole("button", { name: /^昼/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^夕方/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /^夜/ })).toBeEnabled();
  });

  it("今日のプリセットがすべて終わっていたら、明日の日付で出す", async () => {
    // 23:30（日本時間）
    vi.setSystemTime(new Date("2026-10-10T14:30:00Z"));
    const { calls } = welcome({ "/api/v1/availabilities": created("2026-10-11") });
    renderApp();
    await screen.findByRole("heading", { name: "明日のここ暇を1つ出す" });
    await userEvent.click(screen.getByRole("button", { name: /^昼/ }));
    await screen.findByText("出しました");
    const post = calls.find((c) => c.url === "/api/v1/availabilities");
    expect(JSON.parse(String(post?.init.body))).toEqual({ date: "2026-10-11", preset: "day" });
  });

  it("作れなければ（重なりの409）、静かな文言でここ暇タブへ促す", async () => {
    welcome({ "/api/v1/availabilities": problem(409, "invalid_state") });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /^夜/ }));
    const text = await screen.findByText("出せませんでした。ここ暇タブから出してください。");
    expect(text.className).not.toMatch(/red|rose|error/);
  });

  it("受け取れるブラウザなら「お知らせを受け取る」で許可を求めて購読し、endpoint を送る", async () => {
    const push = stubPush({ permission: "default", endpoint: null });
    const { calls } = welcome({
      "/api/v1/push/vapid-key": json({ publicKey: "BONDPuYKWDQXZ6vrw0gaiA" }),
      "/api/v1/push/subscriptions": () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "お知らせを受け取る" }));
    expect(await screen.findByText("この端末で受け取ります")).toBeVisible();
    expect(push.requestPermission).toHaveBeenCalled();
    const post = calls.find((c) => c.url === "/api/v1/push/subscriptions" && c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
  });

  it("許可されなければ、静かな文言を出す", async () => {
    stubPush({ permission: "default", endpoint: null, grant: "denied" });
    welcome();
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "お知らせを受け取る" }));
    expect(await screen.findByText("通知が許可されていません。端末の設定で許可すると受け取れます")).toBeVisible();
  });

  it("すでに受け取る状態なら、ボタンの代わりに「この端末で受け取ります」", async () => {
    stubPush({ permission: "granted" });
    welcome({ "/api/v1/push/subscriptions": () => new Response(null, { status: 204 }) });
    renderApp();
    expect(await screen.findByText("この端末で受け取ります")).toBeVisible();
    expect(screen.queryByRole("button", { name: "お知らせを受け取る" })).toBeNull();
  });

  it("受け取れないブラウザなら、ホーム画面に追加する案内へのリンクを出す", async () => {
    welcome();
    renderApp();
    expect(await screen.findByRole("link", { name: "ホーム画面に追加して、お知らせを受け取る" })).toHaveAttribute(
      "href",
      "/settings/install",
    );
    expect(screen.queryByRole("button", { name: "お知らせを受け取る" })).toBeNull();
  });

  it("プリセットを読み込めなければ、「もう一度」で読み直せる", async () => {
    welcome({ "/api/v1/me/presets": [problem(500, "internal"), presets] });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "もう一度" }));
    expect(await screen.findByRole("heading", { name: "今日のここ暇を1つ出す" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^夜/ })).toBeEnabled();
  });

  it("「友達の一覧へ」で、何もせずに友達タブへ移れる", async () => {
    const { calls } = welcome({
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/friends": empty,
      "/api/v1/invite-links": empty,
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "友達の一覧へ" }));
    await waitFor(() => expect(window.location.pathname).toBe("/friends"));
    expect(calls.some((c) => c.url === "/api/v1/availabilities")).toBe(false);
  });
});
