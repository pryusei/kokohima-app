import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { goBack, navigate } from "../router";
import { json, mockFetch, renderApp, tokenBody, waitForShellGone } from "../test/helpers";
import { AvailabilityChip } from "./AvailabilityChip";
import { BottomSheet, useSheetLeaving } from "./BottomSheet";
import { HeadCount } from "./HeadCount";
import { TabScreen, UnreadBadge } from "./Navigation";
import { Switch } from "./Switch";
import { DESKTOP_QUERY, useDesktop } from "./useDesktop";

// 画面のつながり・シート・部品（docs/specs/T-11-design.md「画面のつながり」「オフライン」、テスト計画）

/** シートの高さ（jsdom には配置がないので offsetHeight を差し替える） */
function sheetHeight(px: number) {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(px);
}

/** performance.now を、呼ぶたびに1秒進む時計にする（離す直前の100msに位置がなく、はじく速さが0になる） */
function slowClock() {
  let t = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (t += 1000));
}

const empty = json({ items: [], nextCursor: null });
const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  tokenStore.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tabs = {
  "/api/v1/auth/refresh": json(tokenBody()),
  "/api/v1/notifications/unread-count": json({ count: 0 }),
  "/api/v1/friend-availabilities": empty,
  "/api/v1/availabilities": empty,
  "/api/v1/recurrence-rules": empty,
  "/api/v1/me/presets": json({ day: { start: "11:00", end: "15:00" }, evening: { start: "16:00", end: "19:00" }, night: { start: "19:00", end: "23:00" } }),
  "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
  "/api/v1/direct-invites": empty,
  "/api/v1/friends": empty,
  "/api/v1/invite-links": empty,
};

describe("下のタブ", () => {
  it("タブは4つ（お知らせはタブにしない）。今の URL のタブにだけ aria-current", async () => {
    mockFetch(tabs);
    renderApp();
    await waitForShellGone();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["みんな", "ここ暇", "誘い", "友達"]);
    expect(within(nav).getByRole("link", { name: "みんな" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(nav).getByRole("link", { name: "誘い" }));
    expect(await screen.findByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
    const after = screen.getByRole("navigation", { name: "タブ" });
    expect(within(after).getByRole("link", { name: "誘い" })).toHaveAttribute("aria-current", "page");
    expect(within(after).getByRole("link", { name: "みんな" })).not.toHaveAttribute("aria-current");
  });
});

describe("シートの後ろのタブ", () => {
  it("/invites/{id} を直接開くと、後ろに誘いタブを出し、後ろは操作できない（inert）", async () => {
    window.history.replaceState(null, "", `/invites/${INVITE_ID}`);
    mockFetch({ ...tabs, [`/api/v1/direct-invites/${INVITE_ID}`]: json({}, 404) });
    renderApp();
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("この誘いは見つかりませんでした。")).toBeVisible();
    const behind = document.querySelector("[inert]");
    expect(behind).not.toBeNull();
    expect(within(behind as HTMLElement).getByText("誘い", { selector: "h1" })).toBeInTheDocument();
  });

  it("/friends/{id} なら後ろは友達タブ", async () => {
    window.history.replaceState(null, "", `/friends/${FRIEND_ID}`);
    mockFetch({ ...tabs, [`/api/v1/friends/${FRIEND_ID}`]: json({}, 404) });
    renderApp();
    await screen.findByText("この友達は見つかりませんでした。");
    const behind = document.querySelector("[inert]") as HTMLElement;
    expect(within(behind).getByText("友達", { selector: "h1" })).toBeInTheDocument();
  });

  it("URL を直接開いて閉じると、アプリの外に出ず後ろのタブへ置き換えて移る", async () => {
    window.history.replaceState(null, "", `/invites/${INVITE_ID}`);
    mockFetch({ ...tabs, [`/api/v1/direct-invites/${INVITE_ID}`]: json({}, 404) });
    const back = vi.spyOn(window.history, "back");
    renderApp();
    await screen.findByText("この誘いは見つかりませんでした。");
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(back).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/invites");
    expect(await screen.findByRole("heading", { name: "誘い", level: 1 })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("router", () => {
  it("navigate は history.state に印を付ける。goBack は印があるときだけ戻る", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    navigate("/invites");
    expect(window.history.state).toEqual({ inApp: true, behind: "/", depth: 1, key: expect.any(String) });
    goBack("/");
    expect(back).toHaveBeenCalledTimes(1);
    window.history.replaceState(null, "", "/meetups/x");
    goBack("/invites");
    expect(back).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/invites");
  });
});

describe("BottomSheet", () => {
  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          開く
        </button>
        {open && (
          <BottomSheet title="試し" label="試し" onClose={() => setOpen(false)}>
            <button type="button">一つめ</button>
            <button type="button">二つめ</button>
          </BottomSheet>
        )}
      </>
    );
  }

  it("Esc・後ろの暗い部分・「閉じる」のボタンで閉じ、閉じたら開いたボタンにフォーカスを戻す", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "開く" });
    for (const close of [
      () => userEvent.keyboard("{Escape}"),
      () => userEvent.click(screen.getByTestId("sheet-scrim")),
      () => userEvent.click(screen.getByRole("button", { name: "閉じる" })),
    ]) {
      await userEvent.click(opener);
      expect(screen.getByRole("dialog", { name: "試し" })).toHaveFocus();
      await close();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(opener).toHaveFocus();
    }
  });

  it("シートを描くときに後ろが inert になってフォーカスが外れても、閉じたら開いたボタンに戻す", async () => {
    // ブラウザは、フォーカスのある要素が inert になるとフォーカスを外す（jsdom はしないので、同じことを layout effect で起こす）
    function Blur() {
      useLayoutEffect(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }, []);
      return null;
    }
    function BlurHost() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            開く
          </button>
          {open && (
            <>
              <Blur />
              <BottomSheet title="試し" label="試し" onClose={() => setOpen(false)}>
                <p>本文</p>
              </BottomSheet>
            </>
          )}
        </>
      );
    }
    render(<BlurHost />);
    const opener = screen.getByRole("button", { name: "開く" });
    await userEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "試し" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("右上の「閉じる」のボタンは1つだけで、つまみは押しても下に引いても閉じるが Tab では止まらない", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "開く" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "試し" });
    expect(within(dialog).getAllByRole("button", { name: "閉じる" })).toHaveLength(1);
    const grip = screen.getByTestId("sheet-grip");
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip).not.toHaveAttribute("tabindex");

    // Tab は「閉じる」→ 一つめ → 二つめ と回り、つまみには止まらない
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "閉じる" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "一つめ" })).toHaveFocus();

    await userEvent.click(grip);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("つまみを押しても下に引いても、onClose は1回だけ呼ぶ（引いたあとに届く click で2回にならない）", () => {
    sheetHeight(600);
    slowClock();
    // 1つのシートが閉じるのは1回だけなので、確かめるたびに開き直す
    const release = (fromY: number, toY: number) => {
      const onClose = vi.fn();
      const { unmount } = render(
        <BottomSheet title="試し" label="試し" onClose={onClose}>
          <p>本文</p>
        </BottomSheet>,
      );
      const grip = screen.getByTestId("sheet-grip");
      act(() => {
        grip.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: fromY }));
        grip.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: toY }));
        grip.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: toY }));
      });
      unmount();
      return onClose.mock.calls.length;
    };

    expect(release(100, 300)).toBe(1); // 下に引く（高さの3割以上）
    expect(release(100, 102)).toBe(1); // 押す
    expect(release(100, 130)).toBe(0); // 少しだけ引いて戻す
    expect(release(200, 100)).toBe(0); // 上に引く：閉じない
  });

  it("オフラインの帯は、スクロールしても上に残る行（つまみとタイトルの行）の中に出す", () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    render(
      <BottomSheet title="試し" label="試し" onClose={() => {}}>
        <p>本文</p>
      </BottomSheet>,
    );
    const header = screen.getByTestId("sheet-grip").parentElement;
    expect(header?.className).toContain("sticky");
    expect(header).toContainElement(screen.getByText(/オフライン/));
    expect(header).toContainElement(screen.getByRole("heading", { name: "試し" }));
    onLine.mockRestore();
  });

  it("開いている間、Tab のフォーカスはシートの外に出ない", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "開く" }));
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("部品", () => {
  it("AvailabilityChip：重なっている枠にだけ灯りと「自分のここ暇と重なっています」、くり返しには「くり返し」", () => {
    const { rerender } = render(<AvailabilityChip text="夜 19:00〜23:00" overlaps />);
    expect(screen.getByText("自分のここ暇と重なっています")).toBeVisible();
    expect(screen.getByText("夜 19:00〜23:00")).toHaveClass("bg-lamp");
    rerender(<AvailabilityChip text="昼 11:00〜15:00" recurring />);
    expect(screen.queryByText("自分のここ暇と重なっています")).toBeNull();
    expect(screen.getByText("くり返し")).toBeVisible();
    expect(screen.getByText("昼 11:00〜15:00")).not.toHaveClass("bg-lamp");
  });

  it("HeadCount：0人なら「まだ応じた人はいません」、1人以上なら人数だけ", () => {
    const { rerender } = render(<HeadCount count={0} />);
    expect(screen.getByText("まだ応じた人はいません")).toBeVisible();
    rerender(<HeadCount count={3} />);
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.getByText("人が応じています")).toBeVisible();
  });
});

describe("オフライン", () => {
  it("offline で帯が出て、送る操作のボタンが押せなくなる。online で元に戻る", async () => {
    mockFetch(tabs);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    window.history.replaceState(null, "", "/availability");
    renderApp();
    // 週の帯のマス（docs/specs/T-55-availability-week-grid.md）
    // 時計は進めていないので、日付によらず7日めの夜のマスを使う
    const night = (await screen.findAllByRole("button", { name: / 夜 .*押すとここ暇にする$/ })).at(-1) as HTMLElement;
    await waitFor(() => expect(night).toBeEnabled());
    onLine.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    await waitFor(() => expect(night).toBeDisabled());
    expect(screen.getByText("オフラインです。つながると最新の内容になります")).toBeVisible();
    onLine.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(night).toBeEnabled());
    expect(screen.queryByText("オフラインです。つながると最新の内容になります")).toBeNull();
  });
});

describe("レビューの指摘（pryusei/kokohima-app#95）", () => {
  it("誘いタブの「送信」から詳細を開いても、後ろは「送信」のまま。閉じると開いたカードにフォーカスが戻る", async () => {
    window.history.replaceState(null, "", "/invites?tab=sent");
    const sent = {
      id: INVITE_ID,
      kind: "kokodou",
      direction: "sent",
      status: "pending",
      counterpart: { id: FRIEND_ID, displayName: "あき", avatarUrl: null, withdrawn: false },
      startsAt: "2026-10-10T10:00:00.000Z",
      endsAt: "2026-10-10T14:00:00.000Z",
      area: null,
      message: null,
      url: null,
      linkPreview: null,
      expiresAt: "2026-10-10T09:00:00.000Z",
      counterProposal: null,
      meetupId: null,
      createdAt: "2026-10-07T00:00:00.000Z",
    };
    mockFetch({
      ...tabs,
      "/api/v1/direct-invites": json({ items: [sent], nextCursor: null }),
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(sent),
    });
    renderApp();
    const card = await screen.findByRole("link", { name: /あきさんへ/ });
    await userEvent.click(card);
    await screen.findByRole("dialog");
    const behind = document.querySelector("[inert]") as HTMLElement;
    expect(within(behind).getByRole("link", { name: "送信", hidden: true })).toHaveAttribute("aria-current", "page");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("?tab=sent");
    await waitFor(() => expect(screen.getByRole("link", { name: /あきさんへ/ })).toHaveFocus());
  });

  it("日本語入力の変換を取り消す Esc では、シートを閉じない", async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="試し" label="試し" onClose={onClose}>
        <input aria-label="ひとこと" />
      </BottomSheet>,
    );
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("シートの中で押し始めて暗い部分で離しても閉じない", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet title="試し" label="試し" onClose={onClose}>
        <p>本文</p>
      </BottomSheet>,
    );
    const scrim = screen.getByTestId("sheet-scrim");
    act(() => {
      screen.getByText("本文").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      scrim.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("シートを開いている間は、アプリの本体（#root）が inert になる（URL を持たないシートでも）", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    const { unmount } = render(
      <BottomSheet title="試し" label="試し" onClose={() => {}}>
        <p>本文</p>
      </BottomSheet>,
      { container: root },
    );
    expect(root.inert).toBe(true);
    expect(screen.getByRole("dialog").closest("#root")).toBeNull();
    unmount();
    expect(root.inert).toBe(false);
    root.remove();
  });

  it("オフラインの間は「自分の暇を見せる」などのスイッチと、取り消し・削除のボタンを押せない", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    window.history.replaceState(null, "", "/availability");
    mockFetch({
      ...tabs,
      "/api/v1/availabilities": json({
        items: [{ id: "44444444-4444-4444-8444-444444444444", startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z", label: "night", source: "manual", date: null }],
        nextCursor: null,
      }),
    });
    renderApp();
    expect(await screen.findByRole("button", { name: / 夜 ここ暇 / })).toBeDisabled();
    onLine.mockRestore();
    const view = render(<Switch checked onChange={() => {}}>自分の暇を見せる</Switch>);
    expect(within(view.container).getByRole("switch")).toBeEnabled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(within(view.container).getByRole("switch")).toBeDisabled();
  });
});

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** matchMedia の差し替え。matches を変えて change を送れる */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    media: DESKTOP_QUERY,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  // 動きを止める設定の問い合わせには true を返す（閉じた直後に onClose を確かめるテストのため。docs/specs/T-56-motion.md「0-3.」）
  const matchMedia = vi.fn((query: string) =>
    query === DESKTOP_QUERY ? media : { ...media, matches: query === REDUCED_MOTION_QUERY },
  );
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    set(matches: boolean) {
      media.matches = matches;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

describe("PC の配置（docs/specs/T-20-desktop-layout.md）", () => {
  // 前のオフラインのテストで止まった TanStack Query の onlineManager を、つながった状態に戻す（QueryClient がまだないので online のイベントは届かない）
  beforeEach(() => {
    onlineManager.setOnline(true);
  });

  it("useDesktop：matchMedia の結果と change に合わせて変わる。matchMedia がなければ false", () => {
    function Probe() {
      return <p>{useDesktop() ? "PC" : "スマホ"}</p>;
    }
    const first = render(<Probe />);
    expect(screen.getByText("スマホ")).toBeVisible();
    first.unmount();
    const media = stubMatchMedia(true);
    render(<Probe />);
    expect(screen.getByText("PC")).toBeVisible();
    media.set(false);
    expect(screen.getByText("スマホ")).toBeVisible();
    media.set(true);
    expect(screen.getByText("PC")).toBeVisible();
  });

  it("左のナビに4つのタブとお知らせ・設定。ヘッダーの鐘は出さない", async () => {
    stubMatchMedia(true);
    mockFetch(tabs);
    renderApp();
    await waitForShellGone();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual(["みんな", "ここ暇", "誘い", "友達", "お知らせ", "設定"]);
    expect(within(nav).getByRole("link", { name: "みんな" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link", { name: "お知らせ" })).toHaveLength(1);
    expect(within(screen.getByRole("banner")).queryByRole("link")).toBeNull();
  });

  it.each([
    ["/notifications", "お知らせ"],
    ["/settings", "設定"],
    ["/settings/calendar", "設定"],
  ])("%s を開いているときは、ナビの「%s」に aria-current", async (path, name) => {
    stubMatchMedia(true);
    window.history.replaceState(null, "", path);
    mockFetch({ ...tabs, "/api/v1/notifications": empty, "/api/v1/me": json({ id: FRIEND_ID, displayName: "あき", avatarUrl: null }) });
    renderApp();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    await waitFor(() => expect(within(nav).getByRole("link", { name })).toHaveAttribute("aria-current", "page"));
    for (const other of within(nav).getAllByRole("link").filter((l) => l.getAttribute("aria-label") !== name)) {
      expect(other).not.toHaveAttribute("aria-current");
    }
  });

  it.each([
    [0, null, "お知らせ"],
    [5, "5", "お知らせ 5件の未読"],
    [99, "99+", "お知らせ 99件以上の未読"],
  ])("ナビのお知らせの未読：%i件なら印は %s、読み上げは「%s」（鐘と同じ）", async (count, badge, label) => {
    stubMatchMedia(true);
    mockFetch({ ...tabs, "/api/v1/notifications/unread-count": json({ count }) });
    renderApp();
    await waitForShellGone();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    const link = await within(nav).findByRole("link", { name: label });
    if (badge) expect(within(link).getByText(badge)).toBeInTheDocument();
    else expect(link.textContent).toBe("お知らせ");
  });

  it.each(["/privacy", "/terms"])("%s は、PC でも左のナビを出さず、未読の数を読みに行かない（ログインしていなくても開く）", async (path) => {
    stubMatchMedia(true);
    window.history.replaceState(null, "", path);
    const { calls } = mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("navigation", { name: "タブ" })).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/v1/notifications"))).toBe(false);
  });

  it("スマホの配置では、ナビにお知らせ・設定を出さず、ヘッダーに鐘を出す。設定の画面ではナビを出さない", async () => {
    stubMatchMedia(false);
    mockFetch(tabs);
    renderApp();
    await waitForShellGone();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "お知らせ" })).toBeVisible();
    await userEvent.click(within(nav).getByRole("link", { name: "友達" }));
    window.history.pushState(null, "", "/settings");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "タブ" })).toBeNull();
  });

  it("PC の配置では、つまみを隠し（lg:hidden）、右上の「閉じる」で閉じる", async () => {
    stubMatchMedia(true);
    const onClose = vi.fn();
    render(
      <BottomSheet title="試し" label="試し" onClose={onClose}>
        <p>本文</p>
      </BottomSheet>,
    );
    expect(screen.getByTestId("sheet-grip")).toHaveClass("lg:hidden");
    await userEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("幅が変わっても、タブの画面の中身は作り直さない（入力中の内容が残る）。鐘とナビの位置だけが変わる", async () => {
    const media = stubMatchMedia(false);
    mockFetch(tabs);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TabScreen title="試し">
          <input aria-label="ひとこと" />
        </TabScreen>
      </QueryClientProvider>,
    );
    const input = screen.getByRole("textbox", { name: "ひとこと" });
    await userEvent.type(input, "こんにちは");
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "お知らせ" })).toBeInTheDocument();
    media.set(true);
    expect(screen.getByRole("textbox", { name: "ひとこと" })).toBe(input);
    expect(input).toHaveValue("こんにちは");
    expect(within(screen.getByRole("banner")).queryByRole("link")).toBeNull();
    // PC ではナビが中身より前（Tab で先に着く）
    const nav = screen.getByRole("navigation", { name: "タブ" });
    expect(nav.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    media.set(false);
    expect(screen.getByRole("textbox", { name: "ひとこと" })).toBe(input);
    expect(input).toHaveValue("こんにちは");
    // スマホでは今のまま、ナビは中身のあと
    expect(screen.getByRole("navigation", { name: "タブ" }).compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe("シートの動き（docs/specs/T-56-motion.md「M-01」「M-02」「M-16」）", () => {
  /** 動きを止めない設定。PC の幅の問い合わせだけ desktop を返す */
  function stubMotion({ desktop = false } = {}) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: q === DESKTOP_QUERY ? desktop : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
    );
  }

  function Host() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          開く
        </button>
        {open && (
          <BottomSheet title="試し" label="試し" onClose={() => setOpen(false)}>
            <button type="button">一つめ</button>
          </BottomSheet>
        )}
      </>
    );
  }

  const renderSheet = (onClose: () => void, title: ReactNode = "試し") =>
    render(
      <BottomSheet title={title} label="試し" onClose={onClose}>
        <p>本文</p>
      </BottomSheet>,
    );

  const closeButton = () => fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
  const pressEscape = () => fireEvent.keyDown(document, { key: "Escape" });
  const closers: [string, () => void][] = [
    ["閉じる", closeButton],
    [
      "暗幕",
      () => {
        const scrim = screen.getByTestId("sheet-scrim");
        fireEvent.pointerDown(scrim);
        fireEvent.click(scrim);
      },
    ],
    ["Esc", pressEscape],
    [
      "つまみ",
      () => {
        const grip = screen.getByTestId("sheet-grip");
        fireEvent.pointerDown(grip, { clientY: 100 });
        fireEvent.pointerUp(grip, { clientY: 100 });
      },
    ],
  ];

  describe("動きを止めない設定", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      stubMotion();
    });
    afterEach(() => vi.useRealTimers());

    it.each(closers)("%s で閉じると、すぐには onClose を呼ばず、出る動きの印が付き、240＋50ms のあとに1回だけ呼ぶ", (_, close) => {
      const onClose = vi.fn();
      renderSheet(onClose);
      act(() => close());
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("sheet-scrim")).toHaveAttribute("data-exiting");
      act(() => vi.advanceTimersByTime(289));
      expect(onClose).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onClose).toHaveBeenCalledTimes(1);
      // 外すまでは出た形のまま（goBack の popstate を待つあいだに戻って見えない）
      expect(screen.getByTestId("sheet-scrim")).toHaveAttribute("data-exiting");
    });

    it("閉じる動きの途中でもう一度「閉じる」・Esc・暗幕を押しても、onClose（goBack）は1回だけ", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      act(() => closeButton());
      act(() => vi.advanceTimersByTime(100));
      for (const [, close] of closers) act(() => close());
      act(() => vi.advanceTimersByTime(1000));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each(closers)("出る動きが終わって onClose を呼んだあと、外れるまでに %s が届いても、onClose（goBack）は1回だけ", (_, close) => {
      const onClose = vi.fn();
      renderSheet(onClose);
      act(() => closeButton());
      act(() => vi.advanceTimersByTime(290));
      expect(onClose).toHaveBeenCalledTimes(1);
      // SheetScreen は goBack の popstate が後から届くので、まだ外れていない
      act(() => close());
      pressEscape();
      act(() => vi.advanceTimersByTime(1000));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("暗い背景の層や中身の transitionend が先に来ても onClose は呼ばず、シートの transitionend で1回だけ呼ぶ", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      act(() => closeButton());
      act(() => {
        screen.getByTestId("sheet-backdrop").dispatchEvent(new Event("transitionend", { bubbles: true }));
        screen.getByText("本文").dispatchEvent(new Event("transitionend", { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        screen.getByRole("dialog").dispatchEvent(new Event("transitionend", { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1000));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("出る動きの途中もフォーカスはシートの中にあり、本体は inert のまま。onClose のあと開いたボタンにフォーカスが戻る", () => {
      const root = document.createElement("div");
      root.id = "root";
      document.body.append(root);
      const view = render(<Host />, { container: root });
      const opener = screen.getByRole("button", { name: "開く" });
      opener.focus();
      fireEvent.click(opener);
      const dialog = screen.getByRole("dialog", { name: "試し" });
      expect(dialog).toHaveFocus();
      act(() => pressEscape());
      expect(dialog).toHaveFocus();
      expect(root.inert).toBe(true);
      act(() => vi.advanceTimersByTime(290));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(root.inert).toBe(false);
      expect(opener).toHaveFocus();
      view.unmount();
      root.remove();
    });

    it("シートの中から、閉じる操作のあと（出る動きの途中）かを確かめられる", () => {
      let leaving: () => boolean = () => true;
      function Probe() {
        leaving = useSheetLeaving();
        return null;
      }
      render(
        <BottomSheet title="試し" label="試し" onClose={() => {}}>
          <Probe />
        </BottomSheet>,
      );
      expect(leaving()).toBe(false);
      act(() => closeButton());
      expect(leaving()).toBe(true);
    });
  });

  it("動きを止める設定でも、外れるまでに続けて Esc・「閉じる」を押したとき、onClose は1回だけ", () => {
    const onClose = vi.fn();
    renderSheet(onClose);
    act(() => pressEscape());
    act(() => pressEscape());
    act(() => closeButton());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("動きを止める設定（matchMedia がない jsdom を含む）では、閉じるとすぐ onClose を呼ぶ", () => {
    for (const [, close] of closers) {
      const onClose = vi.fn();
      const view = renderSheet(onClose);
      act(() => close());
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it("暗い背景は暗幕の中の別の層で、シートはその層の子ではない。押す判定は暗幕が受ける", () => {
    renderSheet(() => {});
    const scrim = screen.getByTestId("sheet-scrim");
    const backdrop = screen.getByTestId("sheet-backdrop");
    const dialog = screen.getByRole("dialog");
    expect(backdrop.parentElement).toBe(scrim);
    expect(backdrop).not.toContainElement(dialog);
    expect(backdrop).toHaveAttribute("aria-hidden", "true");
    expect(backdrop).toHaveClass("bg-scrim", "pointer-events-none");
    expect(scrim).not.toHaveClass("bg-scrim");
  });

  it("シートの中のスクロールを後ろへ抜けさせない（overscroll-behavior: contain）", () => {
    renderSheet(() => {});
    expect(screen.getByRole("dialog")).toHaveClass("overscroll-contain", "kh-sheet");
  });

  it("入る・出る動きの指定：スマホは下から、PC の幅は縮みとフェード（index.css）", () => {
    const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
    expect(DESKTOP_QUERY).toBe("(min-width: 64rem)");
    expect(css).toMatch(/@starting-style\s*\{\s*\.kh-sheet\s*\{\s*transform:\s*translateY\(100%\);/);
    expect(css).toMatch(
      /\.kh-sheet-scrim\[data-exiting\] > \.kh-sheet\s*\{\s*transform:\s*translateY\(100%\);\s*transition:\s*transform var\(--duration-base\) var\(--ease-in\);/,
    );
    const desktop = css.slice(css.indexOf("@media (min-width: 64rem)"));
    expect(desktop).toMatch(/\.kh-sheet-scrim\[data-exiting\] > \.kh-sheet\s*\{\s*transform:\s*scale\(0\.96\);\s*opacity:\s*0;/);
    expect(css).toMatch(/@media \(min-width: 64rem\)\s*\{\s*@starting-style\s*\{\s*\.kh-sheet\s*\{\s*transform:\s*scale\(0\.96\);\s*opacity:\s*0;/);
  });

  describe("引っぱり（M-02）", () => {
    beforeEach(() => {
      sheetHeight(600);
      slowClock();
    });
    const pointer = (el: Element, type: string, clientY: number) =>
      act(() => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientY }));
      });
    const press = (el: Element, from: number, to: number, { move = true, cancel = false } = {}) => {
      pointer(el, "pointerdown", from);
      if (move) pointer(el, "pointermove", to);
      pointer(el, cancel ? "pointercancel" : "pointerup", to);
    };

    it("見出しの行を引いている間はシートに transform が付き、暗い背景が薄くなる。離すと判定どおりに戻る・閉じる", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      const title = screen.getByRole("heading", { name: "試し" });
      const dialog = screen.getByRole("dialog");
      pointer(title, "pointerdown", 100);
      pointer(title, "pointermove", 250);
      expect(dialog.style.transform).toBe("translateY(150px)");
      expect(screen.getByTestId("sheet-backdrop").style.opacity).toBe("0.75");
      expect(screen.getByTestId("sheet-scrim")).toHaveAttribute("data-drag", "dragging");
      // 上へ引くと1/3だけ動く
      pointer(title, "pointermove", 40);
      expect(dialog.style.transform).toBe("translateY(-20px)");
      pointer(title, "pointerup", 150);
      // 高さの3割（180px）に届かず、ゆっくり離したので戻る
      expect(onClose).not.toHaveBeenCalled();
      expect(dialog.style.transform).toBe("");
      expect(screen.getByTestId("sheet-scrim")).toHaveAttribute("data-drag", "settling");
      press(title, 100, 300);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("シートのタイトルを押して離しても閉じない。つまみを押して離すと閉じる", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      press(screen.getByRole("heading", { name: "試し" }), 100, 100, { move: false });
      expect(onClose).not.toHaveBeenCalled();
      press(screen.getByTestId("sheet-grip"), 100, 100, { move: false });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("「閉じる」のボタン・リンク・[role=button] から始めた押し込みは引っぱりにならない", () => {
      const onClose = vi.fn();
      renderSheet(
        onClose,
        <div>
          <a href="/x">リンク</a>
          <span role="button" tabIndex={0}>
            もっと
          </span>
        </div>,
      );
      const dialog = screen.getByRole("dialog");
      for (const el of [
        screen.getByRole("button", { name: "閉じる" }),
        screen.getByRole("link", { name: "リンク" }),
        screen.getByRole("button", { name: "もっと" }),
      ]) {
        pointer(el, "pointerdown", 100);
        pointer(el, "pointermove", 400);
        expect(dialog.style.transform).toBe("");
        pointer(el, "pointerup", 400);
      }
      expect(onClose).not.toHaveBeenCalled();
    });

    it("引いている途中に Esc で閉じても、出る動きの前に引いている見た目（data-drag・transform・濃さ）を外す", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      const title = screen.getByRole("heading", { name: "試し" });
      pointer(title, "pointerdown", 100);
      pointer(title, "pointermove", 250);
      act(() => fireEvent.keyDown(document, { key: "Escape" }));
      const scrim = screen.getByTestId("sheet-scrim");
      expect(scrim).toHaveAttribute("data-exiting");
      expect(scrim).not.toHaveAttribute("data-drag");
      expect(screen.getByRole("dialog").style.transform).toBe("");
      expect(screen.getByTestId("sheet-backdrop").style.opacity).toBe("");
      // そのあと指を動かして離しても、もう一度は閉じない
      pointer(title, "pointermove", 400);
      pointer(title, "pointerup", 400);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("離して戻している途中（settling）に「閉じる」で閉じても、data-drag を外してから出る", () => {
      renderSheet(() => {});
      press(screen.getByRole("heading", { name: "試し" }), 100, 150);
      const scrim = screen.getByTestId("sheet-scrim");
      expect(scrim).toHaveAttribute("data-drag", "settling");
      act(() => fireEvent.click(screen.getByRole("button", { name: "閉じる" })));
      expect(scrim).toHaveAttribute("data-exiting");
      expect(scrim).not.toHaveAttribute("data-drag");
    });

    it("出る動きの指定は、引いている・戻している指定より優先する（index.css）", () => {
      const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
      for (const m of css.matchAll(/\.kh-sheet-scrim\[data-drag="(?:dragging|settling)"\][^{,]*/g)) expect(m[0]).toContain(":not([data-exiting])");
    });

    it("2本めの指や、マウスの左以外のボタンでは引っぱりにしない", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      const title = screen.getByRole("heading", { name: "試し" });
      const grip = screen.getByTestId("sheet-grip");
      const send = (el: Element, type: string, clientY: number, init: { pointerId?: number; isPrimary?: boolean; button?: number } = {}) =>
        act(() => {
          const ev = new MouseEvent(type, { bubbles: true, clientY, button: init.button ?? 0 });
          Object.defineProperties(ev, { pointerId: { value: init.pointerId ?? 1 }, isPrimary: { value: init.isPrimary ?? true } });
          el.dispatchEvent(ev);
        });
      // 1本めで押し、2本めが触れても、1本めの押した位置から測る
      send(title, "pointerdown", 100, { pointerId: 1 });
      send(title, "pointerdown", 400, { pointerId: 2, isPrimary: false });
      send(title, "pointermove", 130, { pointerId: 1 });
      expect(screen.getByRole("dialog").style.transform).toBe("translateY(30px)");
      // 2本めの動き・離しは無視する
      send(title, "pointermove", 600, { pointerId: 2, isPrimary: false });
      expect(screen.getByRole("dialog").style.transform).toBe("translateY(30px)");
      send(title, "pointerup", 600, { pointerId: 2, isPrimary: false });
      expect(screen.getByTestId("sheet-scrim")).toHaveAttribute("data-drag", "dragging");
      send(title, "pointerup", 130, { pointerId: 1 });
      expect(onClose).not.toHaveBeenCalled();
      // つまみを右クリックしても閉じない
      send(grip, "pointerdown", 100, { button: 2 });
      send(grip, "pointerup", 100, { button: 2 });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("pointercancel では閉じずに戻す", () => {
      const onClose = vi.fn();
      renderSheet(onClose);
      press(screen.getByTestId("sheet-grip"), 100, 400, { cancel: true });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog").style.transform).toBe("");
    });

    it("PC の幅では効かない（見出しの行を引いても何もしない）", () => {
      stubMotion({ desktop: true });
      const onClose = vi.fn();
      renderSheet(onClose);
      const title = screen.getByRole("heading", { name: "試し" });
      pointer(title, "pointerdown", 100);
      pointer(title, "pointermove", 400);
      expect(screen.getByRole("dialog").style.transform).toBe("");
      pointer(title, "pointerup", 400);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("見出しの行は touch-action: none（ブラウザのスクロールにしない）", () => {
      renderSheet(() => {});
      expect(screen.getByTestId("sheet-header")).toHaveClass("touch-none", "sticky");
    });
  });
});

describe("下のタブ・画面の切り替え・未読のバッジ・スイッチ（docs/specs/T-56-motion.md「M-07」「M-13」「M-15」「M-18」）", () => {
  // スクロールの位置（jsdom には配置がないので、scrollY と scrollTo を差し替える）
  let scrollY = 0;
  const scrollTo = vi.fn((arg: ScrollToOptions) => {
    scrollY = arg.top ?? 0;
  });
  beforeEach(() => {
    scrollY = 0;
    scrollTo.mockClear();
    vi.spyOn(window, "scrollY", "get").mockImplementation(() => scrollY);
    vi.stubGlobal("scrollTo", scrollTo);
    onlineManager.setOnline(true);
  });

  const page = {
    ...tabs,
    "/api/v1/me": json({ id: FRIEND_ID, displayName: "あき", avatarUrl: null }),
    "/api/v1/broadcasts": empty,
    "/api/v1/meetups": empty,
    "/api/v1/wishes": empty,
    "/api/v1/wishes/suggestions/quota": json({ limit: 0, used: 0, remaining: 0 }),
  };

  /** ブラウザの戻る（jsdom の history.back は popstate を後から出す） */
  async function browserBack() {
    const popped = new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    window.history.back();
    await act(async () => {
      await popped;
    });
  }

  it("今いるタブのアイコンは塗りの版で、下の線は bg-ink。lamp 系のクラスはタブに使わない", async () => {
    mockFetch(page);
    renderApp();
    await waitForShellGone();
    const nav = screen.getByRole("navigation", { name: "タブ" });
    const current = within(nav).getByRole("link", { name: "みんな" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.querySelector("svg[data-filled]")).not.toBeNull();
    expect(within(current).getByTestId("nav-current-line")).toHaveClass("bg-ink");
    const other = within(nav).getByRole("link", { name: "友達" });
    expect(other.querySelector("svg[data-filled]")).toBeNull();
    expect(nav.innerHTML).not.toMatch(/lamp/);
  });

  it("PC の左のナビの今いる場所は bg-head と塗りのアイコン（bg-lamp-soft を使わない）", async () => {
    stubMatchMedia(true);
    mockFetch(page);
    renderApp();
    await waitForShellGone();
    const nav = screen.getByRole("navigation", { name: "タブ" });
    const current = within(nav).getByRole("link", { name: "みんな" });
    expect(current).toHaveClass("lg:bg-head", "text-ink");
    expect(current.querySelector("svg[data-filled]")).not.toBeNull();
    expect(nav.innerHTML).not.toMatch(/lamp-soft|lamp-line/);
  });

  it("今いるタブを押すと一番上までスクロールし、URL は変えない（動きを止める設定では behavior: auto）", async () => {
    window.history.replaceState(null, "", "/invites?tab=sent");
    mockFetch(page);
    renderApp();
    await waitForShellGone();
    scrollY = 640;
    await userEvent.click(within(screen.getByRole("navigation", { name: "タブ" })).getByRole("link", { name: "誘い" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    expect(window.location.pathname + window.location.search).toBe("/invites?tab=sent");
  });

  it("動きのある設定では、今いるタブを押すと smooth で一番上へ", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    mockFetch(page);
    renderApp();
    await waitForShellGone();
    scrollY = 200;
    await userEvent.click(within(screen.getByRole("navigation", { name: "タブ" })).getByRole("link", { name: "みんな" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "smooth" });
  });

  it("タブを移ると、移る先で最後に見ていた位置へ（初めてのタブは一番上）。history.scrollRestoration は manual", async () => {
    // jsdom の history には scrollRestoration がないので、置き方をソースで確かめる
    expect(readFileSync(join(import.meta.dirname, "../router.ts"), "utf8")).toMatch(/window\.history\.scrollRestoration = "manual"/);
    mockFetch(page);
    renderApp();
    await waitForShellGone();
    const nav = () => screen.getByRole("navigation", { name: "タブ" });
    scrollY = 400;
    await userEvent.click(within(nav()).getByRole("link", { name: "友達" }));
    expect(await screen.findByRole("heading", { name: "友達", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    scrollY = 120;
    await userEvent.click(within(nav()).getByRole("link", { name: "みんな" }));
    expect(await screen.findByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 400, behavior: "auto" });
    await userEvent.click(within(nav()).getByRole("link", { name: "友達" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 120, behavior: "auto" });
  });

  it("友達タブでスクロールして設定を開き、戻る（popstate）と友達タブの前の位置に戻る。設定 → 下の画面 → 戻るでも設定の位置に戻る", async () => {
    window.history.replaceState(null, "", "/friends");
    mockFetch({ ...page, "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }) });
    renderApp();
    await waitForShellGone();
    scrollY = 500;
    await userEvent.click(await screen.findByRole("link", { name: /^設定/ }));
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    scrollY = 300;
    await userEvent.click(screen.getByRole("link", { name: /カレンダー連携/ }));
    expect(await screen.findByRole("heading", { name: "カレンダー連携", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    await browserBack();
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 300, behavior: "auto" });
    await browserBack();
    expect(await screen.findByRole("heading", { name: "友達", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: "auto" });
  });

  it("外から直接開いた最初のエントリ（history.state が null）でも、下の画面へ移って戻ると元の位置に戻る", async () => {
    window.history.replaceState(null, "", "/settings");
    mockFetch({ ...page, "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    scrollY = 260;
    await userEvent.click(screen.getByRole("link", { name: /カレンダー連携/ }));
    expect(await screen.findByRole("heading", { name: "カレンダー連携", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
    await browserBack();
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 260, behavior: "auto" });
    // 最初のエントリに足すのは印だけ（アプリの中から開いた印は付けない）
    expect((window.history.state as { inApp?: boolean }).inApp).toBeUndefined();
  });

  it("タブからシートを開いて閉じても、後ろのタブの位置は動かさない", async () => {
    window.history.replaceState(null, "", "/friends");
    mockFetch({ ...page, [`/api/v1/friends/${FRIEND_ID}`]: json({}, 404) });
    renderApp();
    await waitForShellGone();
    scrollY = 260;
    act(() => navigate(`/friends/${FRIEND_ID}`));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await browserBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("navigate は深さ（depth）を積み、置き換えでは深さを変えずにエントリの印（key）を替える。外から直接開いたときは0", () => {
    window.history.replaceState(null, "", "/");
    navigate("/friends");
    const first = window.history.state as { depth: number; key: string };
    expect(first.depth).toBe(1);
    navigate("/settings");
    expect((window.history.state as { depth: number }).depth).toBe(2);
    const before = (window.history.state as { key: string }).key;
    navigate("/settings/calendar", { replace: true });
    expect((window.history.state as { depth: number; key: string }).depth).toBe(2);
    expect((window.history.state as { key: string }).key).not.toBe(before);
    expect(first.key).not.toBe(before);
  });

  describe("View Transitions（M-13）", () => {
    function stubViewTransition() {
      const kinds: (string | undefined)[] = [];
      const start = vi.fn((update: () => void) => {
        kinds.push(document.documentElement.dataset.nav);
        update();
        return { finished: Promise.resolve() };
      });
      Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
      return { start, kinds };
    }
    afterEach(() => {
      delete (document as { startViewTransition?: unknown }).startViewTransition;
      delete document.documentElement.dataset.nav;
    });
    const motion = () =>
      vi.stubGlobal(
        "matchMedia",
        vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
      );

    it("startViewTransition があれば呼び、向きの印（data-nav）を付ける：タブどうしは fade、設定へは push、戻るは pop", async () => {
      motion();
      const { start, kinds } = stubViewTransition();
      window.history.replaceState(null, "", "/friends");
      mockFetch({ ...page, "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }) });
      renderApp();
      await waitForShellGone();
      await userEvent.click(within(screen.getByRole("navigation", { name: "タブ" })).getByRole("link", { name: "みんな" }));
      expect(await screen.findByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
      expect(kinds).toEqual(["fade"]);
      await userEvent.click(within(screen.getByRole("navigation", { name: "タブ" })).getByRole("link", { name: "友達" }));
      await userEvent.click(await screen.findByRole("link", { name: /^設定/ }));
      expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
      expect(kinds).toEqual(["fade", "fade", "push"]);
      await browserBack();
      expect(await screen.findByRole("heading", { name: "友達", level: 1 })).toBeVisible();
      expect(kinds).toEqual(["fade", "fade", "push", "pop"]);
      expect(start).toHaveBeenCalledTimes(4);
      await waitFor(() => expect(document.documentElement.dataset.nav).toBeUndefined());
    });

    it("シートが関わる移動・動きを止める設定では、startViewTransition を呼ばずにそのまま移る", async () => {
      const { start } = stubViewTransition();
      window.history.replaceState(null, "", "/friends");
      mockFetch({ ...page, [`/api/v1/friends/${FRIEND_ID}`]: json({}, 404) });
      renderApp();
      await waitForShellGone();
      // 動きを止める設定（jsdom の既定）
      await userEvent.click(within(screen.getByRole("navigation", { name: "タブ" })).getByRole("link", { name: "みんな" }));
      expect(await screen.findByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
      motion();
      act(() => navigate(`/friends/${FRIEND_ID}`));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(start).not.toHaveBeenCalled();
    });

    it("下のタブ・左のナビは動かさない名前、中身の領域は kh-content（index.css では kh-content にだけ動きを当てる）", async () => {
      mockFetch(page);
      renderApp();
      await waitForShellGone();
      const nav = screen.getByRole("navigation", { name: "タブ" });
      expect(nav).toHaveClass("[view-transition-name:kh-tabbar]", "lg:[view-transition-name:kh-sidenav]");
      expect(screen.getByRole("main")).toHaveClass("[view-transition-name:kh-content]");
      const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
      expect(css).toMatch(/::view-transition-group\(root\),[\s\S]*?::view-transition-group\(kh-tabbar\),[\s\S]*?\{\s*animation: none;/);
      expect(css).toMatch(/html\[data-nav="fade"\]::view-transition-new\(kh-content\)\s*\{\s*animation: kh-vt-in var\(--duration-fast\) var\(--ease-out\) both;/);
      expect(css).toMatch(/html\[data-nav="push"\]::view-transition-new\(kh-content\)\s*\{\s*--kh-vt-x: 30%;\s*animation: kh-vt-in var\(--duration-base\) var\(--ease-out\) both;/);
      expect(css).toMatch(/html\[data-nav="pop"\]::view-transition-old\(kh-content\)\s*\{\s*--kh-vt-x: 30%;\s*animation: kh-vt-out var\(--duration-fast\) var\(--ease-in\) both;/);
    });
  });

  describe("未読のバッジ（M-15）", () => {
    const motion = () =>
      vi.stubGlobal(
        "matchMedia",
        vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
      );

    it("最初の描画・読み終わった最初の数・減ったときはぽんしない。増えたときだけぽんの印が付く", () => {
      const view = render(<UnreadBadge count={undefined} />);
      expect(screen.queryByTestId("unread-badge")).toBeNull();
      view.rerender(<UnreadBadge count={3} />);
      expect(screen.getByTestId("unread-badge")).toHaveTextContent("3");
      expect(screen.getByTestId("unread-badge")).not.toHaveAttribute("data-pop");
      view.rerender(<UnreadBadge count={2} />);
      expect(screen.getByTestId("unread-badge")).not.toHaveAttribute("data-pop");
      view.rerender(<UnreadBadge count={4} />);
      const popped = screen.getByTestId("unread-badge");
      expect(popped).toHaveAttribute("data-pop");
      expect(popped).toHaveClass("kh-badge");
      // 減ったときは要素を作り直さない（もう一度動かない）
      view.rerender(<UnreadBadge count={1} />);
      expect(screen.getByTestId("unread-badge")).toBe(popped);
      view.unmount();
      render(<UnreadBadge count={5} />);
      expect(screen.getByTestId("unread-badge")).not.toHaveAttribute("data-pop");
    });

    it("0 になったら、縮んで薄くなる印（data-exiting）を付け、保険のタイマー（160＋50ms）のあとに消える", () => {
      vi.useFakeTimers();
      motion();
      const view = render(<UnreadBadge count={2} />);
      view.rerender(<UnreadBadge count={0} />);
      expect(screen.getByTestId("unread-badge")).toHaveAttribute("data-exiting");
      expect(screen.getByTestId("unread-badge")).toHaveTextContent("2");
      act(() => vi.advanceTimersByTime(210));
      expect(screen.queryByTestId("unread-badge")).toBeNull();
      vi.useRealTimers();
    });

    it("動きを止める設定では、0 になったらすぐ消える。index.css の kh-badge-pop は scale(.6) → 1.08 → 1（sheet・spring）", () => {
      const view = render(<UnreadBadge count={2} />);
      view.rerender(<UnreadBadge count={0} />);
      expect(screen.queryByTestId("unread-badge")).toBeNull();
      const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
      expect(css).toMatch(/\.kh-badge\[data-pop\]\s*\{\s*animation: kh-badge-pop var\(--duration-sheet\) var\(--ease-spring\);/);
      expect(/@keyframes kh-badge-pop\s*\{([\s\S]*?)\n\}/.exec(css)?.[1]).toMatch(/scale\(0\.6\)[\s\S]*scale\(1\.08\)[\s\S]*scale\(1\)/);
    });
  });

  it("スイッチ（M-18）：つまみの移動は fast・ばね、地の色は fast。押している間は4px伸ばし、オンでは右の端を変えない。押せないときは伸ばさない", () => {
    render(
      <Switch checked onChange={() => {}}>
        見せる
      </Switch>,
    );
    const track = screen.getByRole("switch").nextElementSibling as HTMLElement;
    expect(track).toHaveClass(
      "transition-[background-color,border-color]",
      "duration-(--duration-fast)",
      "after:transition-[translate,width,background-color]",
      "after:duration-(--duration-fast)",
      "after:ease-spring",
      "peer-enabled:peer-active:after:w-6",
      "peer-enabled:peer-active:peer-checked:after:translate-x-4",
    );
    expect(track.className).not.toMatch(/(?:^|\s)peer-active:/);
  });
});
