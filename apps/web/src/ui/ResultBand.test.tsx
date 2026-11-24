import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "./BottomSheet";
import { RESULT_BAND_MS, ResultBandProvider, UNDO_TOAST_MS, useResultBand, type BandMessage } from "./ResultBand";

// 結果の帯（docs/specs/T-56-motion.md「M-09」。T-55 の「取り消す」の一文を、アプリに1つにしたもの）

const source = readFileSync(join(import.meta.dirname, "ResultBand.tsx"), "utf8");

/** 動きを止める設定（matches）を差し替える */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

let renders = 0;
let showBand: (m: BandMessage) => void = () => {};

/** 帯を出す画面。描いた回数を数える */
function Screen() {
  const show = useResultBand();
  showBand = show;
  renders++;
  return <button type="button">マス</button>;
}

const band = () => screen.getByTestId("result-band");
const show = (m: BandMessage) => act(() => showBand(m));

beforeEach(() => {
  vi.useFakeTimers();
  renders = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("結果の帯", () => {
  it("画面に1つだけ。読み上げの場所（role=status）はいつもあり、show で中身が入る", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    expect(screen.getAllByTestId("result-band")).toHaveLength(1);
    expect(band()).toHaveAttribute("role", "status");
    expect(band()).toBeEmptyDOMElement();
    show({ text: "見せないにしました" });
    expect(band()).toHaveTextContent("見せないにしました");
    expect(band().innerHTML).not.toMatch(/red|rose/);
    // 中身を押し下げない
    expect(band().className).toMatch(/\bfixed\b/);
  });

  it("文だけは3.5秒、「取り消す」つきは6秒で消える（動きを止める設定では、消える動きも即時）", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    show({ text: "連携しました" });
    act(() => vi.advanceTimersByTime(RESULT_BAND_MS - 1));
    expect(band()).toHaveTextContent("連携しました");
    act(() => vi.advanceTimersByTime(1));
    expect(band()).toBeEmptyDOMElement();

    const undo = vi.fn();
    show({ text: "10/10（土） 夜をここ暇にしました", undo });
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS - 1));
    expect(screen.getByRole("button", { name: "取り消す" })).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(band()).toBeEmptyDOMElement();
    expect(RESULT_BAND_MS).toBe(3500);
    expect(UNDO_TOAST_MS).toBe(6000);
  });

  it("止めない設定では、消えるときにフェードの印（data-exiting）を付けてから外す", () => {
    stubReducedMotion(false);
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    show({ text: "連携しました" });
    act(() => vi.advanceTimersByTime(RESULT_BAND_MS));
    expect(screen.getByText("連携しました").parentElement).toHaveAttribute("data-exiting");
    act(() => vi.advanceTimersByTime(160 + 50));
    expect(band()).toBeEmptyDOMElement();
  });

  it("同じ文を2回出すと、入る動きからもう一度出る（要素が作り直される）", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    show({ text: "置きました" });
    const first = screen.getByText("置きました").parentElement;
    show({ text: "置きました" });
    const second = screen.getByText("置きました").parentElement;
    expect(second).not.toBe(first);
    expect(second?.className).toContain("animate-kh-rise");
  });

  it("入る動きは普段の指定を最終形にする（opacity-0 を置かない。動きを止める設定ではすぐ見える）", () => {
    stubReducedMotion(true);
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    show({ text: "見せないにしました" });
    const inner = screen.getByText("見せないにしました").parentElement;
    expect(inner?.className).not.toMatch(/\bopacity-0\b/);
    expect(inner?.className).not.toMatch(/motion-safe:/);
    expect(source).not.toMatch(/\bopacity-0\b/);
  });

  it("「取り消す」で戻す操作を呼ぶ。一度だけ", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    const undo = vi.fn();
    show({ text: "10/10（土） 夜をここ暇にしました", undo });
    const button = screen.getByRole("button", { name: "取り消す" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-disabled", "true");
  });

  it("フォーカスがある間・指を乗せている間は消さず、離れたらまた数えはじめる", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    show({ text: "取り消しました", undo: () => {} });
    fireEvent.focus(screen.getByRole("button", { name: "取り消す" }));
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS * 3));
    expect(band()).toHaveTextContent("取り消しました");
    fireEvent.blur(screen.getByRole("button", { name: "取り消す" }));
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(band()).toBeEmptyDOMElement();

    show({ text: "連携しました" });
    fireEvent.pointerEnter(screen.getByText("連携しました").parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(RESULT_BAND_MS * 3));
    expect(band()).toHaveTextContent("連携しました");
    fireEvent.pointerLeave(screen.getByText("連携しました").parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(RESULT_BAND_MS));
    expect(band()).toBeEmptyDOMElement();
  });

  it("次の一文で「取り消す」が消えたら、一文を出したときのフォーカスの場所に戻す", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    const origin = screen.getByRole("button", { name: "マス" });
    origin.focus();
    show({ text: "10/10（土） 夜をここ暇にしました", undo: () => show({ text: "元に戻しました" }) });
    const button = screen.getByRole("button", { name: "取り消す" });
    button.focus();
    fireEvent.click(button);
    expect(band()).toHaveTextContent("元に戻しました");
    expect(origin).toHaveFocus();
  });

  it("show を呼んでも、useResultBand を使う部品は描き直されない", () => {
    render(
      <ResultBandProvider>
        <Screen />
      </ResultBandProvider>,
    );
    const before = renders;
    show({ text: "見せないにしました" });
    show({ text: "連携しました", undo: () => {} });
    act(() => vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(renders).toBe(before);
  });

  it("シートを開いているときも、シートより上に重ねて出す（body の直下。後ろの #root の外）", () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    function WithSheet() {
      const [open, setOpen] = useState(true);
      const shown = useRef(false);
      const show = useResultBand();
      return open ? (
        <BottomSheet title="マス" label="マス" onClose={() => setOpen(false)}>
          <button
            type="button"
            onClick={() => {
              shown.current = true;
              show({ text: "取り消しました", undo: () => {} });
            }}
          >
            取り消す（シート）
          </button>
        </BottomSheet>
      ) : null;
    }
    render(
      <ResultBandProvider>
        <WithSheet />
      </ResultBandProvider>,
      { container: root },
    );
    fireEvent.click(screen.getByRole("button", { name: "取り消す（シート）" }));
    expect(root.inert).toBe(true);
    expect(root.contains(band())).toBe(false);
    expect(band().parentElement).toBe(document.body);
    // シート（z-30）より上
    expect(band().className).toContain("z-40");
    expect(screen.getByTestId("sheet-scrim").className).toContain("z-30");
    expect(screen.getByRole("button", { name: "取り消す" })).toBeVisible();
    root.remove();
  });
});
