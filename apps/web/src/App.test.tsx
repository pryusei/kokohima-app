import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "./auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, waitForShellGone } from "./test/helpers";

// ログインの確認中の殻（docs/specs/T-56-motion.md「M-05」、テスト計画「実装PR③」）

const empty = json({ items: [], nextCursor: null });
const INVITE_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  tokenStore.clear();
});
// 確認の取り直しは端末の中で1つにまとめられるので、待たせたままの確認はテストのあとに終わらせる
const held: (() => void)[] = [];
afterEach(() => {
  for (const release of held.splice(0)) release();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** ログインの確認（更新用トークンでの取り直し）を、release を呼ぶまで待たせる */
function holdRefresh(routes: Parameters<typeof mockFetch>[0] = {}) {
  let release: (make: () => Response) => void = () => {};
  const gate = new Promise<() => Response>((resolve) => {
    release = resolve;
  });
  const fetch = mockFetch({ "/api/v1/auth/refresh": async () => (await gate)(), ...routes });
  held.push(() => release(json({}, 401)));
  return { ...fetch, release: (make: () => Response = json(tokenBody())) => release(make) };
}

/** ヘッダーと下のタブの置き方（jsdom には配置がないので、クラスと並びで確かめる。位置は E2E の boundingBox） */
const layout = () => {
  const header = screen.getByRole("banner");
  const nav = screen.getByRole("navigation", { name: "タブ" });
  return {
    header: header.className,
    title: within(header).getByRole("heading", { level: 1 }).className,
    nav: nav.className,
    links: within(nav)
      .getAllByRole("link")
      .map((l) => l.getAttribute("aria-label")),
    frame: header.parentElement?.className,
  };
};

describe("ログインの確認中の殻（M-05）", () => {
  it("確認中に /invites を開くと、ヘッダー「誘い」と押せない下のタブと骨組みが出て、未読の数を読みに行かない", async () => {
    window.history.replaceState(null, "", "/invites");
    const { calls, release } = holdRefresh({
      "/api/v1/notifications/unread-count": json({ count: 3 }),
      "/api/v1/me": json({ id: "11111111-1111-4111-8111-111111111111", displayName: "ゆう", avatarUrl: null }),
      "/api/v1/direct-invites": empty,
    });
    renderApp();
    expect(screen.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "タブ" });
    expect(nav).toHaveAttribute("inert");
    // 今いるタブの印は付ける
    expect(within(nav).getByRole("link", { name: "誘い" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("status", { name: "読み込み中" })).toHaveAttribute("data-variant", "card");
    // 鐘は押せない印（リンクではない）。未読の数・個人の情報は出さない
    expect(within(screen.getByRole("banner")).queryByRole("link")).toBeNull();
    const before = layout();
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/auth/refresh"]);

    release();
    await waitForShellGone();
    expect(await screen.findByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
    // 確認のあとも、ヘッダーと下のタブは同じクラスで同じ並び
    const after = layout();
    expect(after).toEqual(before);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: /お知らせ/ })).toBeVisible();
  });

  it("後ろにタブを出すシートの URL では、確認中は後ろのタブの殻だけを出し、シートは確認のあとに描く", async () => {
    window.history.replaceState(null, "", `/invites/${INVITE_ID}`);
    const { release } = holdRefresh({
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me": json({ id: "11111111-1111-4111-8111-111111111111", displayName: "ゆう", avatarUrl: null }),
      "/api/v1/direct-invites": empty,
      [`/api/v1/direct-invites/${INVITE_ID}`]: json({}, 404),
    });
    renderApp();
    expect(screen.getByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
    release();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it.each([
    ["/", "みんな", "chips"],
    ["/availability", "ここ暇", "chips"],
    ["/friends", "友達", "list"],
  ])("%s の確認中は、ヘッダー「%s」と %s の骨組み", (path, title, variant) => {
    window.history.replaceState(null, "", path);
    holdRefresh();
    renderApp();
    expect(screen.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(screen.getByRole("status", { name: "読み込み中" })).toHaveAttribute("data-variant", variant);
  });

  it("/settings の確認中は、今のまま殻なしの読み込み中だけ", () => {
    window.history.replaceState(null, "", "/settings");
    holdRefresh();
    renderApp();
    expect(screen.getByRole("status", { name: "読み込み中" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "タブ" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("ログインしていなければ、確認のあとにログイン画面へ移る（今のまま）", async () => {
    window.history.replaceState(null, "", "/friends");
    const { release } = holdRefresh();
    renderApp();
    expect(screen.getByRole("heading", { name: "友達", level: 1 })).toBeVisible();
    release(json({}, 401));
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });
});
