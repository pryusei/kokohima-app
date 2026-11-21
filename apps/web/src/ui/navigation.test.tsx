import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { goBack, navigate } from "../router";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { AvailabilityChip } from "./AvailabilityChip";
import { BottomSheet } from "./BottomSheet";
import { HeadCount } from "./HeadCount";

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
    expect(window.history.state).toEqual({ inApp: true });
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
