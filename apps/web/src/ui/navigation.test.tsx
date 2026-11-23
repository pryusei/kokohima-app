import { onlineManager } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { goBack, navigate } from "../router";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { AvailabilityChip } from "./AvailabilityChip";
import { BottomSheet } from "./BottomSheet";
import { HeadCount } from "./HeadCount";
import { Switch } from "./Switch";
import { DESKTOP_QUERY, useDesktop } from "./useDesktop";

// 画面のつながり・シート・部品（docs/specs/T-11-design.md「画面のつながり」「オフライン」、テスト計画）

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
    expect(window.history.state).toEqual({ inApp: true, behind: "/" });
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

  it("Esc・後ろの暗い部分・つまみで閉じ、閉じたら開いたボタンにフォーカスを戻す", async () => {
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

  it("開いたときに後ろが inert になってフォーカスが外れても、閉じたら開いたボタンに戻す（ブラウザは inert で body にフォーカスを移す）", async () => {
    function InertHost() {
      const [open, setOpen] = useState(false);
      const behind = useRef<HTMLDivElement>(null);
      // jsdom は inert でフォーカスを外さないので、ブラウザと同じく描画の確定時に外す
      useLayoutEffect(() => {
        if (open && behind.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      }, [open]);
      return (
        <>
          <div ref={behind} inert={open ? true : undefined}>
            <button type="button" onClick={() => setOpen(true)}>
              開く
            </button>
          </div>
          {open && (
            <BottomSheet title="試し" label="試し" onClose={() => setOpen(false)}>
              <p>本文</p>
            </BottomSheet>
          )}
        </>
      );
    }
    render(<InertHost />);
    const opener = screen.getByRole("button", { name: "開く" });
    await userEvent.click(opener);
    expect(screen.getByRole("dialog")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
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
    await userEvent.click(await screen.findByRole("button", { name: "ここ暇を追加" }));
    const sheet = screen.getByRole("dialog", { name: "ここ暇を追加" });
    const night = await within(sheet).findByRole("button", { name: /^夜/ });
    expect(night).toBeEnabled();
    onLine.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    await waitFor(() => expect(night).toBeDisabled());
    expect(within(sheet).getByText("オフラインです。つながると最新の内容になります")).toBeVisible();
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
    expect(await screen.findByRole("button", { name: "取り消す" })).toBeDisabled();
    onLine.mockRestore();
    const view = render(<Switch checked onChange={() => {}}>自分の暇を見せる</Switch>);
    expect(within(view.container).getByRole("switch")).toBeEnabled();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(within(view.container).getByRole("switch")).toBeDisabled();
  });
});

/** matchMedia の差し替え。matches を変えて change を送れる */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: initial,
    media: DESKTOP_QUERY,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  const matchMedia = vi.fn((query: string) => (query === DESKTOP_QUERY ? media : { ...media, matches: false }));
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
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    const link = await within(nav).findByRole("link", { name: label });
    if (badge) expect(within(link).getByText(badge)).toBeInTheDocument();
    else expect(link.textContent).toBe("お知らせ");
  });

  it("スマホの配置では、ナビにお知らせ・設定を出さず、ヘッダーに鐘を出す。設定の画面ではナビを出さない", async () => {
    stubMatchMedia(false);
    mockFetch(tabs);
    renderApp();
    const nav = await screen.findByRole("navigation", { name: "タブ" });
    expect(within(nav).getAllByRole("link")).toHaveLength(4);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "お知らせ" })).toBeVisible();
    await userEvent.click(within(nav).getByRole("link", { name: "友達" }));
    window.history.pushState(null, "", "/settings");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await screen.findByRole("heading", { name: "設定", level: 1 })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "タブ" })).toBeNull();
  });

  it("幅が変わっても、開いているシートと入力中の内容は残る", async () => {
    const media = stubMatchMedia(false);
    function Host() {
      return (
        <BottomSheet title="試し" label="試し" onClose={() => {}}>
          <input aria-label="ひとこと" />
        </BottomSheet>
      );
    }
    render(<Host />);
    const input = screen.getByRole("textbox", { name: "ひとこと" });
    await userEvent.type(input, "こんにちは");
    media.set(true);
    expect(screen.getByRole("textbox", { name: "ひとこと" })).toBe(input);
    expect(input).toHaveValue("こんにちは");
    expect(screen.getByRole("button", { name: "閉じる" })).toBeVisible();
  });
});
