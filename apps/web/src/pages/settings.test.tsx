import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// 設定（docs/specs/T-11-design.md「画面のつながり」）：トップ・時間帯プリセット・アカウント

const presets = { day: { start: "11:00", end: "15:00" }, evening: { start: "16:00", end: "19:00" }, night: { start: "19:00", end: "23:00" } };
const me = (displayName: string | null) => ({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName, avatarUrl: null });

beforeEach(() => tokenStore.clear());
afterEach(() => vi.unstubAllGlobals());

describe("設定", () => {
  it("友達タブの「設定」からトップを開き、各設定への入口を出す", async () => {
    window.history.replaceState(null, "", "/friends");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/friends": json({ items: [], nextCursor: null }),
      "/api/v1/invite-links": json({ items: [], nextCursor: null }),
      "/api/v1/me": json(me("ゆう")),
      "/api/v1/calendar/connections": json({ google: { status: "connected", connectedAt: "2026-10-01T00:00:00.000Z" } }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: /設定/ }));
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(await screen.findByText("ゆう")).toBeVisible();
    expect(screen.getByRole("link", { name: /カレンダー連携/ })).toHaveAttribute("href", "/settings/calendar");
    expect(await screen.findByText("Google 連携中")).toBeVisible();
    expect(screen.getByRole("link", { name: /時間帯プリセット/ })).toHaveAttribute("href", "/settings/presets");
    expect(screen.getByRole("link", { name: /通知の設定/ })).toHaveAttribute("href", "/settings/notifications");
    expect(screen.getByRole("link", { name: /^アカウント/ })).toHaveAttribute("href", "/settings/account");
    expect(screen.getByRole("link", { name: /アプリとして使う/ })).toHaveAttribute("href", "/settings/install");
  });

  it("「アプリとして使う」：設定から開き、追加の案内を出す（T-25）", async () => {
    window.history.replaceState(null, "", "/settings/install");
    mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/notifications/unread-count": json({ count: 0 }) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "アプリとして使う", level: 1 })).toBeVisible();
    expect(screen.getByText(/ホーム画面に追加/)).toBeVisible();
  });

  it("時間帯プリセット：境界を変えて保存する（ここ暇タブから移した）", async () => {
    window.history.replaceState(null, "", "/settings/presets");
    const changed = { ...presets, night: { start: "20:00", end: "23:00" } };
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me/presets": [json(presets), json(changed)],
    });
    renderApp();
    const start = await screen.findByLabelText("夜の開始");
    await userEvent.clear(start);
    await userEvent.type(start, "20:00");
    await userEvent.click(screen.getByRole("button", { name: "時間帯を保存" }));
    expect(await screen.findByText("保存しました")).toBeVisible();
    const put = calls.find((c) => c.init.method === "PUT");
    expect(JSON.parse(String(put?.init.body))).toEqual(changed);
  });

  it("アカウント：表示名を変える（友達タブから移した）", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": [json(me("ゆう")), json(me("ゆうき"))],
    });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "表示名" })).closest("section") as HTMLElement;
    const input = await within(section).findByLabelText("表示名");
    expect(input).toHaveValue("ゆう");
    await userEvent.clear(input);
    await userEvent.type(input, "ゆうき");
    await userEvent.click(within(section).getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/v1/me" && c.init.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.init.method === "PATCH");
    expect(JSON.parse(String(patch?.init.body))).toEqual({ displayName: "ゆうき" });
    // 保存してもフォームは作り直されず、「保存しました」と入力した値が残る
    expect(await within(section).findByText("保存しました")).toBeVisible();
    expect(within(section).getByLabelText("表示名")).toHaveValue("ゆうき");
  });

  describe("アカウント：新しい端末のログインのお知らせから開いたとき（docs/specs/T-11-design.md「画面のつながり」）", () => {
    const NOTICE = "新しい端末でのログインのお知らせから開きました。心当たりがなければ、「すべての端末からログアウト」を押してください。";
    let scrolled: HTMLElement[] = [];
    beforeEach(() => {
      scrolled = [];
      Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement) {
        scrolled.push(this);
      });
    });
    afterEach(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    const open = (url: string) => {
      window.history.replaceState(null, "", url);
      mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/me": json(me("ゆう")) });
      renderApp();
    };

    it("?from=new_login なら、ログアウトの節に説明を出し、その節へスクロールする。フォーカスは動かさない", async () => {
      open("/settings/account?from=new_login");
      const section = (await screen.findByRole("heading", { name: "ログアウト" })).closest("section") as HTMLElement;
      expect(within(section).getByText(NOTICE)).toBeVisible();
      await waitFor(() => expect(scrolled).toEqual([section]));
      expect(section).not.toContainElement(document.activeElement as HTMLElement);
      // 説明は静かな文で、警告の色を使わない
      expect(within(section).getByText(NOTICE).className).not.toMatch(/red|rose|error|danger|warn/);
    });

    it.each(["/settings/account", "/settings/account?from=other"])("%s では説明を出さず、スクロールしない", async (url) => {
      open(url);
      await screen.findByRole("heading", { name: "ログアウト" });
      expect(screen.queryByText(NOTICE)).toBeNull();
      expect(scrolled).toEqual([]);
    });
  });
});
