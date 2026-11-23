import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { reauthRedirect } from "./SettingsPage";

// 退会（docs/specs/T-16-withdrawal.md「画面」）

const ME = { id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null, timezone: "Asia/Tokyo" };
const FRIEND = "22222222-2222-4222-8222-222222222222";
const gone = { id: FRIEND, displayName: null, avatarUrl: null, withdrawn: true };

beforeEach(() => tokenStore.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

/** プッシュを購読しているブラウザのふり */
function stubPush() {
  const unsubscribe = vi.fn(async () => true);
  const current = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", unsubscribe };
  const registration = { pushManager: { getSubscription: async () => current, subscribe: vi.fn() } };
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(async () => registration), getRegistration: async () => registration, ready: Promise.resolve(registration) },
  });
  return { unsubscribe };
}

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => () =>
  new Response(JSON.stringify({ type: "about:blank", title: "x", status, code, requestId: "r", ...extra }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });

async function openConfirm() {
  await userEvent.click(await screen.findByRole("button", { name: "退会する" }));
  return screen.findByRole("dialog", { name: "退会の確認" });
}

describe("退会", () => {
  it("確認の画面に、消えるもの・残るもの・取り消せないことを出す。「やめる」で閉じて何も送らない", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const { calls } = mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/me": json(ME) });
    renderApp();
    const dialog = await openConfirm();
    for (const text of ["名前とアイコン", "友達", "カレンダーの連携", "お知らせ", "書いたひとこと・エリア・リンク", "行きたい"]) {
      expect(within(dialog).getByText(text)).toBeVisible();
    }
    expect(within(dialog).getByText(/「退会したユーザー」と残ります/)).toBeVisible();
    expect(within(dialog).getByText(/「やっぱり難しい」になり/)).toBeVisible();
    expect(within(dialog).getByText(/取り消せません/)).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.url === "/api/v1/me/withdrawal")).toBe(false);
  });

  it("204：確認の値を送り、プッシュの購読を解除し、トークンを消してログインの画面に「退会しました」", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const { unsubscribe } = stubPush();
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(ME),
      "/api/v1/push/subscriptions": json({}, 204),
      "/api/v1/me/withdrawal": () => new Response(null, { status: 204 }),
    });
    renderApp();
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole("button", { name: "退会する" }));
    expect(await screen.findByText("退会しました。")).toBeVisible();
    expect(window.location.pathname).toBe("/login");
    const sent = calls.find((c) => c.url === "/api/v1/me/withdrawal");
    expect(sent?.init.method).toBe("POST");
    expect(JSON.parse(String(sent?.init.body))).toEqual({ confirm: "withdraw" });
    expect(unsubscribe).toHaveBeenCalled();
    expect(tokenStore.get()).toBeNull();
  });

  it("403 reauth_required：今と同じ方法（Apple）のログインへ移り、戻り先で確認の画面をもう一度出す", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const go = vi.spyOn(reauthRedirect, "go").mockImplementation(() => {});
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(ME),
      "/api/v1/me/withdrawal": problem(403, "reauth_required", { reauthProvider: "apple" }),
    });
    const view = renderApp();
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole("button", { name: "退会する" }));
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith(`/api/v1/auth/apple/start?returnTo=${encodeURIComponent("/settings/account?withdraw=1")}`),
    );
    view.unmount();

    window.history.replaceState(null, "", "/settings/account?withdraw=1");
    renderApp();
    expect(await screen.findByRole("dialog", { name: "退会の確認" })).toBeVisible();
  });

  it("403 で方法が分からなければ（null）、ログインの画面で選んでもらう。確認の画面に今の表示名を出す", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const go = vi.spyOn(reauthRedirect, "go").mockImplementation(() => {});
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(ME),
      "/api/v1/me/withdrawal": problem(403, "reauth_required", { reauthProvider: null }),
    });
    renderApp();
    const dialog = await openConfirm();
    expect(within(dialog).getByText("ゆうさんのアカウントを退会します。")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "退会する" }));
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent("/settings/account?withdraw=1")}`));
  });

  it("401：ログインの画面へ（文言は出さない）。そのほかの失敗は静かな文言", async () => {
    window.history.replaceState(null, "", "/settings/account");
    mockFetch({
      "/api/v1/auth/refresh": [json(tokenBody()), json({}, 401)],
      "/api/v1/me": json(ME),
      "/api/v1/me/withdrawal": [problem(500, "internal_error"), problem(401, "unauthenticated")],
    });
    renderApp();
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole("button", { name: "退会する" }));
    const failed = await within(dialog).findByText("退会できませんでした。もう一度お試しください");
    expect(failed.className).not.toMatch(/red|danger|error/);
    await userEvent.click(within(dialog).getByRole("button", { name: "退会する" }));
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(screen.queryByText("退会しました。")).toBeNull();
  });

  it("誘いの一覧でも、退会した相手は「退会したユーザー」（さんを付けない）", async () => {
    window.history.replaceState(null, "", "/invites?tab=sent");
    const invite = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "asobo",
      direction: "sent",
      counterpart: gone,
      status: "expired",
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      area: null,
      message: null,
      url: null,
      linkPreview: null,
      expiresAt: "2026-10-10T00:00:00.000Z",
      counterProposal: null,
      meetupId: null,
      createdAt: "2026-10-09T00:00:00.000Z",
    };
    const empty = json({ items: [], nextCursor: null });
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/direct-invites": json({ items: [invite], nextCursor: null }),
      [`/api/v1/direct-invites/${invite.id}`]: json(invite),
      "/api/v1/broadcasts": empty,
      "/api/v1/meetups": empty,
    });
    renderApp();
    expect(await screen.findByText("退会したユーザーへ")).toBeVisible();
    expect(screen.queryByText(/名前未設定/)).toBeNull();
  });

  it("相手が退会した人なら「退会したユーザー」と出す（「名前未設定の友達」と区別する）", async () => {
    window.history.replaceState(null, "", "/notifications");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 1 }),
      "/api/v1/notifications/read": () => new Response(null, { status: 204 }),
      "/api/v1/notifications": json({
        items: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            kind: "invite_declined",
            actor: gone,
            subjectId: "44444444-4444-4444-8444-444444444444",
            count: null,
            device: null,
            createdAt: "2026-10-10T00:00:00.000Z",
            readAt: null,
          },
        ],
        nextCursor: null,
      }),
    });
    renderApp();
    expect(await screen.findByText("退会したユーザーは今回は難しいみたい")).toBeVisible();
    expect(screen.queryByText(/名前未設定/)).toBeNull();
  });
});
