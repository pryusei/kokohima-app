import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_MS, SaveButton, useSaveState } from "./SaveButton";

// 保存のボタン（docs/specs/T-54-save-and-goodbye-copy.md）

/** 保存すると、すぐに保存済みの値を入れ替えるだけのフォーム */
function Harness() {
  const [value, setValue] = useState("ゆう");
  const [saved, setSaved] = useState("ゆう");
  const { state, markSaved } = useSaveState({ changed: value !== saved, pending: false });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(value);
        markSaved();
      }}
    >
      <input aria-label="値" value={value} onChange={(e) => setValue(e.target.value)} />
      <SaveButton state={state}>保存する</SaveButton>
    </form>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("保存のボタン", () => {
  it("保存済みの値と同じあいだは押せず、変えると押せる。元に戻すとまた押せない", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "保存する" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText("値"), { target: { value: "ゆうき" } });
    expect(button).toBeEnabled();
    fireEvent.change(screen.getByLabelText("値"), { target: { value: "ゆう" } });
    expect(button).toBeDisabled();
  });

  it("保存できたら、ボタンそのものが約2秒「✓ 保存しました」（操作の青）になり、元に戻って押せなくなる", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("値"), { target: { value: "ゆうき" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));

    // ✓ は読み上げない。読み上げはボタンの外の status
    const saved = screen.getByRole("button", { name: "保存しました" });
    expect(saved).toHaveTextContent("✓保存しました");
    expect(saved).toBeDisabled();
    // 「✓ 保存しました」は操作の青の枠（成立の青緑は成立だけ。docs/specs/T-56-motion.md「M-03」）
    expect(saved.className).toContain("border-action");
    expect(saved.className).toContain("text-action");
    expect(saved.className).not.toMatch(/\bbg-meet|\btext-meet/);
    // 押せないあいだの色（disabled:）は付けないので、青が負けない
    expect(saved.className).not.toContain("disabled:bg-surface-sunken");
    expect(saved.className).not.toMatch(/red|danger|error/);
    // 色の切り替えは --duration-fast の transition だけで、アニメーション（animate-）は付けない（T-56 M-14）
    expect(saved.className).not.toMatch(/\banimate-/);
    expect(saved.className).toContain("kh-submit-motion");
    expect(screen.getByRole("status")).toHaveTextContent("保存しました");

    act(() => vi.advanceTimersByTime(SAVED_MS - 1));
    expect(screen.getByRole("button", { name: "保存しました" })).toBeDisabled();

    act(() => vi.advanceTimersByTime(1));
    const back = screen.getByRole("button", { name: "保存する" });
    expect(back).toBeDisabled();
    expect(back.className).toContain("bg-action");
    expect(back.className).toContain("disabled:bg-surface-sunken");
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("「✓ 保存しました」のあいだに入力を変えたら、すぐ押せるボタンに戻る", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("値"), { target: { value: "ゆうき" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    expect(screen.getByRole("button", { name: "保存しました" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("値"), { target: { value: "ゆうきち" } });
    expect(screen.getByRole("button", { name: "保存する" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("送信中は灰色にせず、元の色のまま薄くして「保存しています…」。aria-disabled で、押しても・フォームを送っても何もしない（T-56 M-14）", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    function Pending() {
      const { state } = useSaveState({ changed: true, pending: true });
      return (
        <form onSubmit={onSubmit}>
          <SaveButton state={state}>保存する</SaveButton>
        </form>
      );
    }
    render(<Pending />);
    const button = screen.getByRole("button", { name: "保存しています…" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.className).toContain("bg-action");
    expect(button.className).toContain("opacity-70");
    button.focus();
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });
});
