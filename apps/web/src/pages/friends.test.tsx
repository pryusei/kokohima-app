import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

const LINK_ID = "11111111-1111-4111-8111-111111111111";
const me = (displayName: string | null) => ({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName, avatarUrl: null });
const friend = (over: Record<string, unknown> = {}) => ({
  id: "22222222-2222-4222-8222-222222222222",
  displayName: "あき",
  avatarUrl: null,
  sharesMyAvailability: true,
  friendsSince: "2026-10-07T00:00:00.000Z",
  ...over,
});
const lookupOk = json({ linkId: LINK_ID, inviter: { displayName: "あき", avatarUrl: null } });

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("招待リンクの受け口", () => {
  it("未ログインでも /login へ移さずに描画し、トークンをURLから消してストレージに置かない", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { calls } = mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
    renderApp();
    expect(await screen.findByText(/さんから、ここ暇の友達の招待が届いています/)).toBeVisible();
    expect(screen.getByText("あき")).toBeVisible();
    expect(window.location.pathname).toBe("/invite");
    expect(window.location.hash).toBe("");
    expect(setItem).not.toHaveBeenCalled();
    const lookup = calls.find((c) => c.url === "/api/v1/invite-links/lookup");
    expect(JSON.parse(String(lookup?.init.body))).toEqual({ token: "secret-invite-token" });
    // ログインは returnTo=/invite で始める
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toHaveAttribute(
      "href",
      "/api/v1/auth/google/start?returnTo=%2Finvite",
    );
  });

  it("ログイン後に戻ったら（フラグメントなし）、招待Cookieで発行者を表示してから「友達になる」を出す", async () => {
    window.history.replaceState(null, "", "/invite");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/invite-links/lookup": lookupOk,
      "/api/v1/invite-links/accept": json({ friend: friend(), alreadyFriends: false }, 201),
      "/api/v1/friends": json({ items: [friend()], nextCursor: null }),
      "/api/v1/me": json(me("ゆう")),
      "/api/v1/invite-links": json({ items: [], nextCursor: null }),
    });
    renderApp();
    expect(await screen.findByText("あき")).toBeVisible();
    const lookup = calls.find((c) => c.url === "/api/v1/invite-links/lookup");
    expect(JSON.parse(String(lookup?.init.body))).toEqual({});
    await userEvent.click(await screen.findByRole("button", { name: "友達になる" }));
    await waitFor(() => expect(window.location.pathname).toBe("/friends"));
    const accept = calls.find((c) => c.url === "/api/v1/invite-links/accept");
    expect(JSON.parse(String(accept?.init.body))).toEqual({ linkId: LINK_ID });
  });

  it.each([
    [404, /このリンクは使えません/],
    [409, /これはあなたが作ったリンクです/],
  ])("accept が %i なら静かな文言を出す", async (status, text) => {
    window.history.replaceState(null, "", "/invite");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/invite-links/lookup": lookupOk,
      "/api/v1/invite-links/accept": json({}, status),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "友達になる" }));
    expect(await screen.findByText(text)).toBeVisible();
  });

  it("accept が通信エラーなら再送せず、友達一覧への導線を出す", async () => {
    window.history.replaceState(null, "", "/invite");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/invite-links/lookup": lookupOk,
      "/api/v1/invite-links/accept": () => Promise.reject(new TypeError("Failed to fetch")),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "友達になる" }));
    expect(await screen.findByRole("link", { name: "友達一覧" })).toHaveAttribute("href", "/friends");
    expect(calls.filter((c) => c.url === "/api/v1/invite-links/accept")).toHaveLength(1);
  });

  it("使えないリンク（lookup が404）は1種類の文言だけ", async () => {
    window.history.replaceState(null, "", "/invite#t=x");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": json({}, 404) });
    renderApp();
    expect(await screen.findByText(/このリンクは使えません/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Googleでログイン" })).toBeNull();
  });
});

describe("友達タブ", () => {
  function renderFriends(routes: Record<string, Parameters<typeof mockFetch>[0][string]> = {}) {
    window.history.replaceState(null, "", "/friends");
    return mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me("ゆう")),
      "/api/v1/invite-links": json({ items: [], nextCursor: null }),
      "/api/v1/friends": json({ items: [friend(), friend({ id: "33333333-3333-4333-8333-333333333333", displayName: null })], nextCursor: null }),
      ...routes,
    });
  }

  it("表示名が null の友達を「名前未設定の友達」と表示する", async () => {
    renderFriends();
    renderApp();
    expect(await screen.findByText("名前未設定の友達")).toBeVisible();
    expect(screen.getByText("あき")).toBeVisible();
  });

  it("「自分の暇を見せる」は楽観的更新：押すとすぐ切り替わる", async () => {
    let resolve: (r: Response) => void = () => {};
    renderFriends({
      "/api/v1/friends/22222222-2222-4222-8222-222222222222": () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    });
    renderApp();
    const [toggle] = await screen.findAllByRole("switch", { name: "自分の暇を見せる" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle as HTMLElement);
    expect(toggle).not.toBeChecked();
    resolve(new Response(JSON.stringify(friend({ sharesMyAvailability: false })), { status: 200 }));
  });

  it("「自分の暇を見せる」の保存に失敗したら元に戻し、静かな文言を出す", async () => {
    renderFriends({ "/api/v1/friends/22222222-2222-4222-8222-222222222222": json({}, 500) });
    renderApp();
    const [toggle] = await screen.findAllByRole("switch", { name: "自分の暇を見せる" });
    await userEvent.click(toggle as HTMLElement);
    expect(await screen.findByText(/保存できませんでした/)).toBeVisible();
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it("表示名が未設定なら、招待リンクを作る前に表示名の入力を出す", async () => {
    renderFriends({
      "/api/v1/me": [json(me(null)), json(me("ゆう"))],
    });
    renderApp();
    const input = await screen.findByLabelText("表示名");
    expect(screen.queryByRole("button", { name: "招待リンクを作る" })).toBeNull();
    await userEvent.type(input, "ゆう");
    await userEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(await screen.findByRole("button", { name: "招待リンクを作る" })).toBeVisible();
  });

  it("招待リンクを作ると、URLを一度だけ表示する", async () => {
    const url = "http://localhost:5173/invite#t=abc";
    renderFriends({
      "/api/v1/invite-links": [
        json({ items: [], nextCursor: null }),
        json({
          id: LINK_ID,
          url,
          expiresAt: "2026-10-10T00:00:00.000Z",
          maxUses: 5,
          uses: 0,
          createdAt: "2026-10-07T00:00:00.000Z",
        }, 201),
        json({ items: [], nextCursor: null }),
      ],
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
    expect(await screen.findByLabelText("招待リンクのURL")).toHaveValue(url);
    expect(screen.getByText(/この画面でしか表示できません/)).toBeVisible();
  });
});
