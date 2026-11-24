import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Collapse } from "./Collapse";

// 高さの開閉（docs/specs/T-56-motion.md「0-4.」、テスト計画「実装PR①」）

beforeEach(() => {
  vi.useFakeTimers();
  // 動きを止めない設定
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const box = (view: ReturnType<typeof render>) => view.container.firstElementChild as HTMLElement;

describe("Collapse", () => {
  it("最初の描画で show が true なら、開いた見た目で中身がある。false なら中身を描かない", () => {
    const open = render(<Collapse show>中身</Collapse>);
    expect(box(open)).not.toHaveAttribute("data-closed");
    expect(screen.getByText("中身")).toBeVisible();
    open.unmount();
    const closed = render(<Collapse show={false}>中身</Collapse>);
    expect(box(closed)).toHaveAttribute("data-closed");
    expect(screen.queryByText("中身")).toBeNull();
  });

  it("閉じる動きのあいだは中身を描き（inert）、保険のタイマー（160＋50ms）のあとに描かない", () => {
    const view = render(<Collapse show>中身</Collapse>);
    view.rerender(<Collapse show={false}>中身</Collapse>);
    expect(box(view)).toHaveAttribute("data-closed");
    const inner = screen.getByText("中身");
    expect(inner).toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(209));
    expect(screen.getByText("中身")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("中身")).toBeNull();
  });

  it("閉じる途中で show が true に戻ると、中身が残り（タイマーが過ぎても消えない）、開いた見た目に戻る", () => {
    const view = render(<Collapse show>中身</Collapse>);
    view.rerender(<Collapse show={false}>中身</Collapse>);
    act(() => vi.advanceTimersByTime(100));
    view.rerender(<Collapse show>中身</Collapse>);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("中身")).toBeInTheDocument();
    expect(screen.getByText("中身")).not.toHaveAttribute("inert");
    expect(box(view)).not.toHaveAttribute("data-closed");
  });

  it("閉じて・開いて・もう一度閉じても、閉じ終わると中身が消える", () => {
    const view = render(<Collapse show>中身</Collapse>);
    view.rerender(<Collapse show={false}>中身</Collapse>);
    act(() => vi.advanceTimersByTime(210));
    expect(screen.queryByText("中身")).toBeNull();
    view.rerender(<Collapse show>中身</Collapse>);
    expect(screen.getByText("中身")).toBeInTheDocument();
    view.rerender(<Collapse show={false}>中身</Collapse>);
    act(() => vi.advanceTimersByTime(210));
    expect(screen.queryByText("中身")).toBeNull();
  });

  it("動きを止める設定では、閉じるとすぐ中身が消える", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    const view = render(<Collapse show>中身</Collapse>);
    view.rerender(<Collapse show={false}>中身</Collapse>);
    expect(screen.queryByText("中身")).toBeNull();
  });
});
