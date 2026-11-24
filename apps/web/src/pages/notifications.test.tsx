import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { unreadLabel } from "../ui/Navigation";

// お知らせ一覧・通知の設定・プッシュの購読（docs/specs/T-07-notification.md「お知らせ一覧」「プッシュの購読と Service Worker」）

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const FRIEND = "11111111-1111-4111-8111-111111111111";
const aki = { id: FRIEND, displayName: "あき", avatarUrl: null, withdrawn: false };
const item = (n: number, kind: string, over: Record<string, unknown> = {}) => ({
  id: ID(n),
  kind,
  actor: null,
  subjectId: null,
  count: null,
  device: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  readAt: null,
  ...over,
});
const page = (items: unknown[]) => json({ items, nextCursor: null });
const noContent = () => new Response(null, { status: 204 });
const prefs = { invites: true, broadcasts: true, meetups: true, friends: true, calendar: true, lockScreen: "hidden" };
const KEYS = { p256dh: "BP".padEnd(87, "A"), auth: "au".padEnd(22, "A") };

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** プッシュが使えるブラウザのふり */
function stubPush(opts: { permission?: NotificationPermission; endpoint?: string | null } = {}) {
  const endpoint = opts.endpoint === undefined ? "https://fcm.googleapis.com/fcm/send/abc" : opts.endpoint;
  const unsubscribe = vi.fn(async () => true);
  const sub = (url: string) => ({ endpoint: url, unsubscribe, toJSON: () => ({ endpoint: url, keys: KEYS }) });
  let current = endpoint ? sub(endpoint) : null;
  const subscribe = vi.fn(async () => (current = sub("https://fcm.googleapis.com/fcm/send/new")));
  const registration = { pushManager: { getSubscription: async () => current, subscribe } };
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: opts.permission ?? "granted", requestPermission });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => registration), getRegistration: async () => registration, ready: Promise.resolve(registration) },
  });
  return { subscribe, unsubscribe, requestPermission };
}
afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("お知らせ一覧", () => {
  it("種類ごとの文言を出し、対象の画面へのリンクにする。断り・キャンセルも同じ静かな見た目", async () => {
    window.history.replaceState(null, "", "/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 3 }),
      "/api/v1/notifications/read": noContent,
      "/api/v1/notifications": page([
        item(1, "invite_received", { actor: aki, subjectId: "i1" }),
        item(2, "invite_declined", { actor: aki, subjectId: "i2", readAt: "2026-10-10T00:00:00.000Z" }),
        item(3, "meetup_cancelled", { subjectId: "m1", readAt: "2026-10-10T00:00:00.000Z" }),
        item(4, "broadcast_received", { actor: { ...aki, displayName: null }, subjectId: "b1" }),
        item(5, "availability_cancelled", { count: 2 }),
        item(6, "calendar_reauth"),
        item(7, "new_login", { device: "Chrome / Windows" }),
        item(8, "meetup_left", { subjectId: "m2" }),
      ]),
    });
    renderApp();
    expect(await screen.findByRole("link", { name: "あきさんから誘いが届きました" })).toHaveAttribute("href", "/invites/i1");
    const declined = screen.getByRole("link", { name: "あきさんは今回は難しいみたい" });
    const cancelled = screen.getByRole("link", { name: "予定がなくなりました" });
    expect(cancelled).toHaveAttribute("href", "/meetups/m1");
    for (const quiet of [declined, cancelled]) {
      expect(quiet.className).not.toMatch(/red|rose|error|danger/);
    }
    expect(screen.getByRole("link", { name: "名前未設定の友達さんが募集しています" })).toHaveAttribute("href", "/broadcasts/b1");
    expect(screen.getByRole("link", { name: "カレンダーの予定と重なったここ暇を2件取り消しました" })).toHaveAttribute("href", "/availability");
    expect(screen.getByRole("link", { name: "カレンダーの連携が切れました" })).toHaveAttribute("href", "/settings/calendar");
    expect(screen.getByRole("link", { name: "新しい端末でログインがありました（Chrome / Windows）" })).toHaveAttribute("href", "/settings/account?from=new_login");
    expect(screen.getByRole("link", { name: "予定から1人抜けました" })).toBeVisible();
  });

  it("相手が退会などで読めない（actor が null）ときは、名前のない文言にする", async () => {
    window.history.replaceState(null, "", "/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/notifications/read": noContent,
      "/api/v1/notifications": page([
        item(1, "invite_received", { subjectId: "i1" }),
        item(2, "invite_declined", { subjectId: "i2" }),
        item(3, "meetup_confirmed", { subjectId: "m1" }),
        item(4, "friend_added", { subjectId: FRIEND }),
      ]),
    });
    renderApp();
    expect(await screen.findByRole("link", { name: "誘いが届きました" })).toHaveAttribute("href", "/invites/i1");
    expect(screen.getByRole("link", { name: "誘いに返事がありました" })).toBeVisible();
    expect(screen.getByRole("link", { name: "予定が成立しました" })).toBeVisible();
    expect(screen.getByRole("link", { name: "友達が増えました" })).toBeVisible();
    expect(screen.queryByText(/名前未設定の友達/)).toBeNull();
  });

  it("ヘッダーの鐘に未読の数を出す（赤を使わない）。一覧を開いたら、いちばん新しい id で既読にし、戻ると数が消える", async () => {
    window.history.replaceState(null, "", "/");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/friend-availabilities": page([]),
      "/api/v1/notifications/unread-count": [json({ count: 2 }), json({ count: 0 })],
      "/api/v1/notifications/read": noContent,
      "/api/v1/notifications": page([item(2, "calendar_reauth"), item(1, "calendar_reauth")]),
    });
    renderApp();
    const bell = await screen.findByRole("link", { name: "お知らせ 2件の未読" });
    expect(within(bell).getByText("2").className).not.toMatch(/red|rose/);
    await userEvent.click(bell);
    expect(await screen.findByRole("heading", { name: "お知らせ" })).toBeVisible();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/notifications/read")).toBe(true));
    const read = calls.filter((c) => c.url === "/api/v1/notifications/read");
    expect(read).toHaveLength(1);
    expect(read[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(read[0]?.init.body))).toEqual({ upTo: ID(2) });
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(await screen.findByRole("link", { name: "お知らせ" })).toBeVisible();
  });

  it.each([
    [0, null, "お知らせ"],
    [1, "1", "お知らせ 1件の未読"],
    [98, "98", "お知らせ 98件の未読"],
    [99, "99+", "お知らせ 99件以上の未読"],
  ])("未読が %i 件なら、数は %s で読み上げは「%s」（API は99で頭打ち）", (count, badge, label) => {
    expect(unreadLabel(count)).toEqual({ badge, label });
  });

  it("お知らせがなければ、既読の API を呼ばない", async () => {
    window.history.replaceState(null, "", "/notifications");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/notifications": page([]),
    });
    renderApp();
    expect(await screen.findByText("お知らせはありません")).toBeVisible();
    expect(calls.some((c) => c.url === "/api/v1/notifications/read")).toBe(false);
  });

  it("友達追加のお知らせの「この人に見せない」：押すと見せないにして静かに知らせる", async () => {
    window.history.replaceState(null, "", "/notifications");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 1 }),
      "/api/v1/notifications/read": noContent,
      "/api/v1/notifications": page([item(1, "friend_added", { actor: aki, subjectId: FRIEND })]),
      [`/api/v1/friends/${FRIEND}`]: json({}),
    });
    renderApp();
    expect(await screen.findByRole("link", { name: "あきさんと友達になりました" })).toHaveAttribute("href", `/friends/${FRIEND}`);
    await userEvent.click(screen.getByRole("button", { name: "この人に見せない" }));
    expect((await screen.findByText("見せないにしました")).className).not.toMatch(/red|rose/);
    const patch = calls.find((c) => c.url === `/api/v1/friends/${FRIEND}`);
    expect(patch?.init.method).toBe("PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ sharesMyAvailability: false });
    expect(screen.queryByRole("button", { name: "この人に見せない" })).toBeNull();
  });

  it("友達でなくなっていれば（404）、ボタンを消す", async () => {
    window.history.replaceState(null, "", "/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 1 }),
      "/api/v1/notifications/read": noContent,
      "/api/v1/notifications": page([item(1, "friend_added", { actor: aki, subjectId: FRIEND })]),
      [`/api/v1/friends/${FRIEND}`]: json({ type: "not_found" }, 404),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "この人に見せない" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "この人に見せない" })).toBeNull());
    expect(screen.queryByText("見せないにしました")).toBeNull();
  });
});

describe("通知の設定", () => {
  it("種別ごとのスイッチが5つ。切り替えると、その種別だけを PATCH する", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": ({ init }) =>
        json(init.method === "PATCH" ? { ...prefs, invites: false } : calls.some((c) => c.init.method === "PATCH") ? { ...prefs, invites: false } : prefs)(),
    });
    renderApp();
    const invites = await screen.findByRole("switch", { name: "誘い" });
    expect(screen.getAllByRole("switch")).toHaveLength(5);
    expect(invites).toBeChecked();
    expect(screen.getByText("新しい端末でのログインのお知らせは止められません")).toBeVisible();
    await userEvent.click(invites);
    await waitFor(() => expect(invites).not.toBeChecked());
    const patch = calls.find((c) => c.init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ invites: false });
    expect(screen.getByRole("switch", { name: "募集" })).toBeChecked();
  });

  it("ロック画面の見本を2つ並べて、いつでも変えられる。今の設定に印が付き、選ぶとその項目だけを PATCH する（T-35）", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    let saved: Record<string, unknown> = { ...prefs, lockScreen: "detailed" };
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": ({ init }) => {
        if (init.method === "PATCH") saved = { ...saved, ...(JSON.parse(String(init.body)) as object) };
        return json(saved)();
      },
    });
    renderApp();
    const group = await screen.findByRole("group", { name: "ロック画面に出す中身" });
    const hidden = within(group).getByRole("radio", { name: "出さない" });
    await waitFor(() => expect(within(group).getByRole("radio", { name: "名前と日時を出す" })).toBeChecked());
    expect(hidden).toHaveAccessibleDescription("見本：誘いが届きました");
    expect(within(group).getByText("どちらでも、ひとこと・場所・リンクは出ません")).toBeVisible();
    expect(screen.getByText("断り・見送り・取り消しと、夜22時〜朝7時は鳴らさず、お知らせ一覧にだけ残します")).toBeVisible();
    await userEvent.click(hidden);
    await waitFor(() => expect(hidden).toBeChecked());
    const patch = calls.find((c) => c.init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ lockScreen: "hidden" });
    // 選んだ枠は lamp の輪。赤やエラーの色を使わない
    expect(hidden.closest("label")?.className).toMatch(/border-lamp-line/);
    expect(group.innerHTML).not.toMatch(/red|rose|error/);
  });

  it("ロック画面：今の設定を読み込むまでは、どちらにも印を付けず選べない（T-35）", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": () => pending,
    });
    renderApp();
    const group = await screen.findByRole("group", { name: "ロック画面に出す中身" });
    const radios = within(group).getAllByRole("radio");
    for (const r of radios) {
      expect(r).not.toBeChecked();
      expect(r).toBeDisabled();
      expect(r.closest("label")?.className).not.toMatch(/border-lamp-line/);
    }
    release(json({ ...prefs, lockScreen: "detailed" })());
    await waitFor(() => expect(within(group).getByRole("radio", { name: "名前と日時を出す" })).toBeChecked());
    expect(within(group).getByRole("radio", { name: "出さない" })).not.toBeChecked();
  });

  it("ロック画面：今の設定を読み込めなければ、静かな文と「もう一度」を出す（T-35）", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": json({ code: "internal", message: "x" }, 500),
    });
    renderApp();
    const group = await screen.findByRole("group", { name: "ロック画面に出す中身" });
    const message = await within(group).findByText("今の設定を読み込めませんでした。もう一度お試しください");
    expect(message.closest("div")?.className ?? "").not.toMatch(/red|rose|error/);
    expect(within(group).getByRole("button", { name: /もう一度/ })).toBeVisible();
    for (const r of within(group).getAllByRole("radio")) expect(r).not.toBeChecked();
  });

  it("ロック画面：保存できなければ元の選択に戻し、静かな色で「変更できませんでした」と出す（T-35）", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": ({ init }) =>
        init.method === "PATCH" ? json({ code: "internal", message: "x" }, 500)() : json(prefs)(),
    });
    renderApp();
    const group = await screen.findByRole("group", { name: "ロック画面に出す中身" });
    const hidden = within(group).getByRole("radio", { name: "出さない" });
    const detailed = within(group).getByRole("radio", { name: "名前と日時を出す" });
    await waitFor(() => expect(hidden).toBeChecked());
    await userEvent.click(detailed);
    const message = await within(group).findByText("変更できませんでした。もう一度お試しください");
    expect(message).toHaveClass("text-ink-muted");
    expect(message.className).not.toMatch(/red|rose|error|danger/);
    await waitFor(() => expect(hidden).toBeChecked());
    expect(detailed).not.toBeChecked();
  });

  it("ロック画面：オフラインの間は選べない（T-35）", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": json(prefs),
    });
    renderApp();
    const group = await screen.findByRole("group", { name: "ロック画面に出す中身" });
    await waitFor(() => expect(within(group).getByRole("radio", { name: "出さない" })).toBeChecked());
    for (const r of within(group).getAllByRole("radio")) expect(r).toBeDisabled();
    await userEvent.click(within(group).getByText("名前と日時を出す"));
    expect(calls.some((c) => c.init.method === "PATCH")).toBe(false);
    onLine.mockRestore();
  });

  it("プッシュが使えない端末では、ホーム画面への追加とメールの案内を出す", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": json(prefs),
    });
    renderApp();
    expect(await screen.findByText("ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます")).toBeVisible();
    expect(screen.queryByRole("button", { name: "この端末でプッシュ通知を受け取る" })).toBeNull();
    expect(screen.getByRole("link", { name: "追加の方法" })).toHaveAttribute("href", "/settings/install");
  });

  it("「この端末でプッシュ通知を受け取る」：許可を取り、公開鍵で購読し、endpoint と暗号化の鍵を送る。やめると endpoint だけで DELETE する", async () => {
    window.history.replaceState(null, "", "/settings/notifications");
    const push = stubPush({ permission: "default", endpoint: null });
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me/notification-preferences": json(prefs),
      "/api/v1/push/vapid-key": json({ publicKey: "BONDPuYKWDQXZ6vrw0gaiA" }),
      "/api/v1/push/subscriptions": noContent,
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "この端末でプッシュ通知を受け取る" }));
    await screen.findByRole("button", { name: "この端末でのプッシュ通知をやめる" });
    expect(push.requestPermission).toHaveBeenCalled();
    expect(push.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const post = calls.find((c) => c.url === "/api/v1/push/subscriptions" && c.init.method === "POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/new", keys: KEYS });

    vi.stubGlobal("Notification", { permission: "granted", requestPermission: push.requestPermission });
    await userEvent.click(screen.getByRole("button", { name: "この端末でのプッシュ通知をやめる" }));
    await screen.findByRole("button", { name: "この端末でプッシュ通知を受け取る" });
    const del = calls.find((c) => c.url === "/api/v1/push/subscriptions" && c.init.method === "DELETE");
    expect(JSON.parse(String(del?.init.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    expect(push.unsubscribe).toHaveBeenCalled();
  });
});

describe("購読の送り直しとログアウト", () => {
  const home = {
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/notifications/unread-count": json({ count: 0 }),
    "/api/v1/me": json({ id: FRIEND, displayName: "じぶん", avatarUrl: null, timezone: "Asia/Tokyo" }),
    "/api/v1/friends": page([]),
    "/api/v1/invite-links": page([]),
    "/api/v1/push/subscriptions": noContent,
  };

  it("アプリを開くと（ログイン中・許可済み）、いまの endpoint と鍵を送り直す", async () => {
    window.history.replaceState(null, "", "/friends");
    stubPush();
    const { calls } = mockFetch(home);
    renderApp();
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/push/subscriptions")).toBe(true));
    const post = calls.find((c) => c.url === "/api/v1/push/subscriptions");
    expect(post?.init.method).toBe("POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: KEYS });
  });

  it("通知を許可していなければ、送り直さない", async () => {
    window.history.replaceState(null, "", "/settings/account");
    stubPush({ permission: "default" });
    const { calls } = mockFetch(home);
    renderApp();
    await screen.findByRole("button", { name: "ログアウト" });
    expect(calls.some((c) => c.url === "/api/v1/push/subscriptions")).toBe(false);
  });

  it("ログアウトの前に、この端末の購読を消す", async () => {
    window.history.replaceState(null, "", "/settings/account");
    stubPush();
    const { calls } = mockFetch({ ...home, "/api/v1/auth/logout": noContent });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "ログアウト" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/auth/logout")).toBe(true));
    const order = calls.filter((c) => c.init.method === "DELETE" || c.url === "/api/v1/auth/logout").map((c) => `${c.init.method} ${c.url}`);
    expect(order).toEqual(["DELETE /api/v1/push/subscriptions", "POST /api/v1/auth/logout"]);
  });
});

describe("Service Worker", () => {
  function load() {
    const listeners = new Map<string, (event: unknown) => void>();
    const self = {
      addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
      registration: { showNotification: vi.fn(async () => undefined) },
      clients: { openWindow: vi.fn(async () => null) },
      fetch: vi.fn(),
    };
    new Function("self", swSource)(self);
    return { listeners, self };
  }

  const pushWith = (data: unknown) => {
    const { listeners, self } = load();
    const waitUntil = vi.fn();
    listeners.get("push")?.({ waitUntil, data });
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    return self.registration.showNotification;
  };

  it("push：中身の本文（種類に応じた文）を waitUntil で出す。同じお知らせは同じ tag（T-35）", () => {
    const show = pushWith({ json: () => ({ v: 1, id: ID(1), body: "誘いが届きました" }) });
    expect(show).toHaveBeenCalledWith("ここ暇", { body: "誘いが届きました", tag: `kokohima-${ID(1)}` });
  });

  it("push：中身がない・読めない・形が違うときは、決まった文言を出す", () => {
    for (const data of [
      null,
      { json: () => { throw new SyntaxError("bad"); } },
      { json: () => ({ v: 2, body: "未来の形" }) },
      { json: () => ({ v: 1, body: "" }) },
      { json: () => ({ v: 1, body: 1 }) },
    ]) {
      expect(pushWith(data)).toHaveBeenCalledWith("ここ暇", { body: "新しいお知らせがあります", tag: "kokohima" });
    }
  });

  it("push：長すぎる本文は200字で切る", () => {
    const show = pushWith({ json: () => ({ v: 1, id: ID(2), body: "あ".repeat(500) }) });
    expect(show).toHaveBeenCalledWith("ここ暇", { body: "あ".repeat(200), tag: `kokohima-${ID(2)}` });
  });

  it("notificationclick：お知らせ一覧を開く。API を呼ばず、キャッシュもしない", () => {
    const { listeners, self } = load();
    const waitUntil = vi.fn();
    const close = vi.fn();
    listeners.get("notificationclick")?.({ waitUntil, notification: { close } });
    expect(close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith("/notifications");
    expect([...listeners.keys()].sort()).toEqual(["notificationclick", "push"]);
    expect(swSource).not.toMatch(/fetch\(|caches|importScripts|pushsubscriptionchange/);
  });
});
