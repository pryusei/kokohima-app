import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate, swappedSheetHeight, swapSheet } from "../router";
import { BottomSheet } from "./BottomSheet";
import { Loading } from "./feedback";

// シートの差し替え（docs/specs/T-56-motion.md「M-03」、テスト計画「実装PR②」）

/** 動きを止める設定（matches）を差し替える */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

/** jsdom には配置がないので、シートの高さは「height の指定があればその値、なければ中身の高さ（natural）」にする */
let natural = 700;
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

beforeEach(() => {
  vi.useFakeTimers();
  natural = 700;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("role") !== "dialog") return 0;
      return this.style.height ? parseFloat(this.style.height) : natural;
    },
  });
  window.history.replaceState(null, "", "/invites/new");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
});

const dialog = () => screen.getByRole("dialog");
const scrim = () => screen.getByTestId("sheet-scrim");

/** 作成のシートを出して、詳細へ差し替える。詳細は読み込み中から描く */
function swapToDetail() {
  const view = render(
    <BottomSheet key="new" title="誘う" label="誘う" onClose={() => {}}>
      <p>作成</p>
    </BottomSheet>,
  );
  act(() => swapSheet("/invites/1"));
  natural = 300;
  view.rerender(
    <BottomSheet key="detail" title="誘い" label="誘い" onClose={() => {}}>
      <Loading />
    </BottomSheet>,
  );
  return view;
}

describe("シートの差し替え", () => {
  it("移った先のシートは入る動きを走らせず（data-swap）、前の高さ（px）から始まり、読み込み中はその高さのまま", () => {
    stubReducedMotion(false);
    const view = swapToDetail();
    expect(window.location.pathname).toBe("/invites/1");
    expect(scrim()).toHaveAttribute("data-swap", "hold");
    expect(dialog().style.height).toBe("700px");
    // 読み込み中の描き直しでも、骨組みの高さへ縮めない
    view.rerender(
      <BottomSheet key="detail" title="誘い" label="誘い" onClose={() => {}}>
        <Loading />
      </BottomSheet>,
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(dialog().style.height).toBe("700px");
    expect(scrim()).toHaveAttribute("data-swap", "hold");
  });

  it("中身が描けたら、測った高さ（px）の height に替わり（auto にしない）、保険のタイマーのあとに height の指定が外れる", () => {
    stubReducedMotion(false);
    const view = swapToDetail();
    view.rerender(
      <BottomSheet key="detail" title="誘い" label="誘い" onClose={() => {}}>
        <p>詳細</p>
      </BottomSheet>,
    );
    expect(scrim()).toHaveAttribute("data-swap", "reveal");
    expect(dialog().style.height).toBe("300px");
    act(() => vi.advanceTimersByTime(360 + 49));
    expect(dialog().style.height).toBe("300px");
    act(() => vi.advanceTimersByTime(1));
    expect(dialog().style.height).toBe("");
    expect(scrim()).not.toHaveAttribute("data-swap");
  });

  it("動きを止める設定では height を付けず、差し替えの印も付けない", () => {
    stubReducedMotion(true);
    const view = swapToDetail();
    expect(dialog().style.height).toBe("");
    expect(scrim()).not.toHaveAttribute("data-swap");
    view.rerender(
      <BottomSheet key="detail" title="誘い" label="誘い" onClose={() => {}}>
        <p>詳細</p>
      </BottomSheet>,
    );
    expect(dialog().style.height).toBe("");
  });

  it("覚えた高さは2回読んでも同じ値（StrictMode で初期化が2回走っても）。次の navigate のあとは使われない", () => {
    render(
      <BottomSheet title="誘う" label="誘う" onClose={() => {}}>
        <p>作成</p>
      </BottomSheet>,
    );
    act(() => swapSheet("/invites/1"));
    expect(swappedSheetHeight()).toBe(700);
    expect(swappedSheetHeight()).toBe(700);
    act(() => navigate("/invites"));
    expect(swappedSheetHeight()).toBeNull();
    // 同じ URL に戻っても、もう使わない
    act(() => navigate("/invites/1", { replace: true }));
    expect(swappedSheetHeight()).toBeNull();
  });

  it("移った先の URL と今の URL が違うときは使わない", () => {
    render(
      <BottomSheet title="誘う" label="誘う" onClose={() => {}}>
        <p>作成</p>
      </BottomSheet>,
    );
    act(() => swapSheet("/invites/1"));
    window.history.replaceState(null, "", "/invites/2");
    expect(swappedSheetHeight()).toBeNull();
  });
});

describe("覚えた高さを消すのは、ブラウザの戻る・進むだけ", () => {
  it("navigate が出す合成の popstate（isTrusted でない）では消さない", () => {
    render(
      <BottomSheet title="誘う" label="誘う" onClose={() => {}}>
        <p>作成</p>
      </BottomSheet>,
    );
    act(() => swapSheet("/invites/1"));
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(swappedSheetHeight()).toBe(700);
  });

  it("ブラウザの戻る（isTrusted の popstate）で消え、進むで同じ URL に戻っても使わない", async () => {
    vi.useRealTimers();
    window.history.pushState(null, "", "/invites/new");
    render(
      <BottomSheet title="誘う" label="誘う" onClose={() => {}}>
        <p>作成</p>
      </BottomSheet>,
    );
    act(() => swapSheet("/invites/1"));
    expect(swappedSheetHeight()).toBe(700);
    const popped = () => new Promise<PopStateEvent>((resolve) => window.addEventListener("popstate", resolve, { once: true }));
    let event = popped();
    window.history.back();
    expect((await event).isTrusted).toBe(true);
    event = popped();
    window.history.forward();
    await event;
    expect(window.location.pathname).toBe("/invites/1");
    expect(swappedSheetHeight()).toBeNull();
  });
});

describe("BottomSheet の dismiss（送れたあと出る動きで閉じる。M-03）", () => {
  it("dismiss が true になると、出る動き（data-exiting）のあとに onClose を1回だけ呼ぶ。閉じる途中の Esc と重なっても2回呼ばない", () => {
    stubReducedMotion(false);
    const onClose = vi.fn();
    const view = render(
      <BottomSheet title="行きたい" label="行きたい" onClose={onClose}>
        <p>中身</p>
      </BottomSheet>,
    );
    view.rerender(
      <BottomSheet title="行きたい" label="行きたい" onClose={onClose} dismiss>
        <p>中身</p>
      </BottomSheet>,
    );
    expect(scrim()).toHaveAttribute("data-exiting");
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("動きを止める設定では、dismiss ですぐ onClose を1回呼ぶ", () => {
    stubReducedMotion(true);
    const onClose = vi.fn();
    const view = render(
      <BottomSheet title="行きたい" label="行きたい" onClose={onClose}>
        <p>中身</p>
      </BottomSheet>,
    );
    view.rerender(
      <BottomSheet title="行きたい" label="行きたい" onClose={onClose} dismiss>
        <p>中身</p>
      </BottomSheet>,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
