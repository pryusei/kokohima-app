import { screen, waitFor, within } from "@testing-library/react";
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
  it("回数の上限（429）は「混み合っています」を静かに出す", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    mockFetch({
      "/api/v1/auth/refresh": json({}, 401),
      "/api/v1/invite-links/lookup": json({ type: "about:blank", title: "x", status: 429, code: "rate_limited", requestId: "r" }, 429),
    });
    renderApp();
    const text = await screen.findByText("混み合っています。少し待ってから、もう一度開いてください。");
    expect(text.className).not.toMatch(/red|rose/);
  });

  it("未ログインでも /login へ移さずに描画し、トークンをURLから消してストレージに置かない", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { calls } = mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
    renderApp();
    expect(await screen.findByText("あきさんから、ここ暇の友達の招待が届いています。")).toBeVisible();
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
    expect(await screen.findByText("あきさんから、ここ暇の友達の招待が届いています。")).toBeVisible();
    const lookup = calls.find((c) => c.url === "/api/v1/invite-links/lookup");
    expect(JSON.parse(String(lookup?.init.body))).toEqual({});
    await userEvent.click(await screen.findByRole("button", { name: "友達になる" }));
    await waitFor(() => expect(window.location.pathname).toBe("/friends"));
    const accept = calls.find((c) => c.url === "/api/v1/invite-links/accept");
    expect(JSON.parse(String(accept?.init.body))).toEqual({ linkId: LINK_ID });
  });

  it.each([
    [404, /友達になれませんでした。招待リンクをもう一度開いてください/],
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

  it("lookup が通信エラーなら、リンクを開き直すよう促す（友達一覧への導線は出さない）", async () => {
    window.history.replaceState(null, "", "/invite#t=x");
    mockFetch({
      "/api/v1/auth/refresh": json({}, 401),
      "/api/v1/invite-links/lookup": () => Promise.reject(new TypeError("Failed to fetch")),
    });
    renderApp();
    expect(await screen.findByText(/リンクをもう一度開いてください/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "友達一覧" })).toBeNull();
  });

  describe("LINEのアプリ内ブラウザ（T-28）", () => {
    const LINE_UA = "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/15.2.0";

    it("未ログインなら、トークン入りの「ブラウザで開き直す」を出し、ストレージに置かない", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINE_UA);
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      window.history.replaceState(null, "", "/invite?openExternalBrowser=1#t=secret-invite-token");
      mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
      renderApp();
      const reopen = await screen.findByRole("link", { name: "ブラウザで開き直す" });
      expect(reopen).toHaveAttribute("href", "/invite?openExternalBrowser=1#t=secret-invite-token");
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("");
      expect(setItem).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "ブラウザで開き直す" }).className).not.toMatch(/red|rose|error|warn/);
    });

    it("ログイン済みなら帯を出さない", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINE_UA);
      window.history.replaceState(null, "", "/invite#t=x");
      mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/invite-links/lookup": lookupOk });
      renderApp();
      expect(await screen.findByRole("button", { name: "友達になる" })).toBeVisible();
      expect(screen.queryByRole("link", { name: "ブラウザで開き直す" })).toBeNull();
    });

    it("トークンがない（ログインから戻った）・使えないリンクなら帯を出さない", async () => {
      vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINE_UA);
      window.history.replaceState(null, "", "/invite");
      mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
      const { unmount } = renderApp();
      expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
      expect(screen.queryByRole("link", { name: "ブラウザで開き直す" })).toBeNull();
      unmount();

      window.history.replaceState(null, "", "/invite#t=x");
      mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": json({}, 404) });
      renderApp();
      expect(await screen.findByText(/このリンクは使えません/)).toBeVisible();
      expect(screen.queryByRole("link", { name: "ブラウザで開き直す" })).toBeNull();
    });

    it("LINE以外のブラウザでは帯を出さない", async () => {
      window.history.replaceState(null, "", "/invite#t=x");
      mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
      renderApp();
      expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
      expect(screen.queryByRole("link", { name: "ブラウザで開き直す" })).toBeNull();
    });
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
    // 招待リンクの発行はシートで開く（docs/specs/T-11-design.md）
    await userEvent.click(await screen.findByRole("button", { name: "招待リンクを作る" }));
    const sheet = screen.getByRole("dialog", { name: "招待リンクを作る" });
    const input = await within(sheet).findByLabelText("表示名");
    expect(within(sheet).queryByRole("button", { name: "招待リンクを作る" })).toBeNull();
    await userEvent.type(input, "ゆう");
    await userEvent.click(within(sheet).getByRole("button", { name: "保存する" }));
    expect(await within(sheet).findByRole("button", { name: "招待リンクを作る" })).toBeVisible();
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
    const sheet = screen.getByRole("dialog", { name: "招待リンクを作る" });
    await userEvent.click(await within(sheet).findByRole("button", { name: "招待リンクを作る" }));
    expect(await within(sheet).findByLabelText("招待リンクのURL")).toHaveValue(url);
    expect(screen.getByText(/この画面でしか表示できません/)).toBeVisible();
    // LINEで送る（T-28）：line.me の共有のURLを新しいタブで開く。本文に openExternalBrowser 付きの招待リンク
    const line = within(sheet).getByRole("link", { name: "LINEで送る" });
    expect(line).toHaveAttribute("target", "_blank");
    expect(line).toHaveAttribute("rel", "noopener noreferrer");
    const href = line.getAttribute("href") ?? "";
    expect(href.startsWith("https://line.me/R/share?text=")).toBe(true);
    expect(decodeURIComponent(href.slice("https://line.me/R/share?text=".length))).toBe(
      "ここ暇で友達になろう\nhttp://localhost:5173/invite?openExternalBrowser=1#t=abc",
    );
  });
});
