import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_TOAST_MS, UndoToast } from "./UndoToast";

// 下に数秒出す「取り消す」（docs/specs/T-55-availability-week-grid.md「振る舞い 3.」）

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("UndoToast", () => {
  it("数秒で消える。「取り消す」を押すと戻す操作を呼ぶ。赤を使わない", () => {
    const onDone = vi.fn();
    const undo = vi.fn();
    render(<UndoToast message={{ id: 1, text: "10/10（土） 夜をここ暇にしました", undo }} onDone={onDone} />);
    expect(screen.getByRole("status")).toHaveTextContent("10/10（土） 夜をここ暇にしました");
    expect(screen.getByRole("status").innerHTML).not.toMatch(/red|rose/);
    fireEvent.click(screen.getByRole("button", { name: "取り消す" }));
    expect(undo).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS - 1));
    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("フォーカスがある間は消さず、離れたらまた数えはじめる", () => {
    const onDone = vi.fn();
    render(<UndoToast message={{ id: 1, text: "取り消しました", undo: () => {} }} onDone={onDone} />);
    fireEvent.focus(screen.getByRole("button", { name: "取り消す" }));
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS * 3));
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByRole("button", { name: "取り消す" }));
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("戻す操作がなければ「取り消す」を出さない。読み上げの場所はいつも置いておく", () => {
    const { rerender } = render(<UndoToast message={null} onDone={() => {}} />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    rerender(<UndoToast message={{ id: 2, text: "元に戻しました" }} onDone={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("元に戻しました");
    expect(screen.queryByRole("button", { name: "取り消す" })).toBeNull();
  });
});
