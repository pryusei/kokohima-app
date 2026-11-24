import { act, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendButton } from "./Button";
import { SENT_HOLD_MS, SubmitButton, useSubmitState } from "./SubmitButton";

// 送る操作のボタン（docs/specs/T-56-motion.md「M-14」「M-03」、テスト計画「実装PR②」）

/** 動きを止める設定（matches）を差し替える */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

const setOnline = (online: boolean) => {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setOnline(true);
});

describe("SendButton の送信中（M-14）", () => {
  it("送信中は aria-disabled で disabled ではなく、灰色にならず薄くなる。押してもフォームを送っても何も起きず、フォーカスが残る", () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <SendButton type="submit" variant="primary" pending onClick={onClick}>
          送っています…
        </SendButton>
      </form>,
    );
    const button = screen.getByRole("button", { name: "送っています…" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.className).toContain("opacity-70");
    expect(button.className).toContain("bg-action");
    button.focus();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
  });

  it("押した縮みは押せるときだけの条件で付け、送信中に打ち消しのクラスを後ろに足さない（Tailwind は後ろのクラスが勝つとは限らない）", () => {
    render(
      <SendButton variant="primary" pending>
        送っています…
      </SendButton>,
    );
    const classes = screen.getByRole("button").className.split(/\s+/);
    expect(classes).toContain("not-disabled:not-aria-disabled:active:scale-[.98]");
    expect(classes.filter((c) => /(^|:)active:scale-/.test(c))).toEqual(["not-disabled:not-aria-disabled:active:scale-[.98]"]);
  });

  it("送るボタンの transition は、Tailwind v4 の active:scale-* が動かす scale を含む（transform だけにしない）", () => {
    const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
    const rules = [...css.matchAll(/\n\.kh-send-motion(?:\.kh-submit-motion)? \{([^}]*)\}/g)].map((m) => m[1] ?? "");
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule).toMatch(/\bscale var\(--duration-press\) var\(--ease-out\)/);
  });

  it("オフラインでは disabled の灰色。送信中とオフラインでクラスが違う", () => {
    const { rerender } = render(
      <SendButton variant="primary" pending>
        送る
      </SendButton>,
    );
    const pendingClass = screen.getByRole("button").className;
    act(() => setOnline(false));
    rerender(<SendButton variant="primary">送る</SendButton>);
    const offline = screen.getByRole("button");
    expect(offline).toBeDisabled();
    expect(offline).not.toHaveAttribute("aria-disabled");
    expect(offline.className).not.toContain("opacity-70");
    expect(offline.className).not.toBe(pendingClass);
    expect(pendingClass).toContain("opacity-70");
  });
});

/** 送ると pending を少しだけ立て、成功したら succeed で次へ進むフォーム */
function Harness({ fail = false, next }: { fail?: boolean; next: () => void }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const { state, succeed } = useSubmitState(pending);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (state !== "ready") return;
        setPending(true);
        setFailed(false);
        setTimeout(() => {
          setPending(false);
          if (fail) setFailed(true);
          else succeed(next);
        }, 100);
      }}
    >
      <SubmitButton state={state} sending="送っています…" done="送りました">
        誘う
      </SubmitButton>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          送れませんでした。もう一度お試しください
        </p>
      )}
    </form>
  );
}

describe("SubmitButton（M-03）", () => {
  it("ready → sending（「送っています…」）→ done（「✓ 送りました」、variant saved、✓ は aria-hidden、status が「送りました」）。止めない設定では500ms見せてから次へ", () => {
    stubReducedMotion(false);
    const next = vi.fn();
    render(<Harness next={next} />);
    fireEvent.click(screen.getByRole("button", { name: "誘う" }));
    const sending = screen.getByRole("button", { name: "送っています…" });
    expect(sending).toHaveAttribute("aria-disabled", "true");
    act(() => vi.advanceTimersByTime(100));
    const done = screen.getByRole("button", { name: "送りました" });
    expect(done).toHaveTextContent("✓送りました");
    expect(done.querySelector('[aria-hidden="true"]')).toHaveTextContent("✓");
    // 「✓ 保存しました」と同じ見た目（操作の青の枠）
    expect(done.className).toContain("border-action");
    expect(done.className).toContain("text-action");
    expect(done.className).not.toMatch(/\bbg-meet|red|danger|error/);
    expect(screen.getByText("送りました", { selector: "[role=status]" })).toBeInTheDocument();
    // done のあいだは押しても送らない
    expect(done).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(done);
    act(() => vi.advanceTimersByTime(SENT_HOLD_MS - 1));
    expect(next).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(next).toHaveBeenCalledTimes(1);
    expect(SENT_HOLD_MS).toBe(500);
  });

  it("動きを止める設定（jsdom の既定を含む）では、done を見せずにすぐ次へ進む", () => {
    const next = vi.fn();
    render(<Harness next={next} />);
    fireEvent.click(screen.getByRole("button", { name: "誘う" }));
    act(() => vi.advanceTimersByTime(100));
    expect(next).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "送りました" })).toBeNull();
  });

  it("失敗は静かな文言で、ボタンは ready に戻る", () => {
    stubReducedMotion(false);
    const next = vi.fn();
    render(<Harness fail next={next} />);
    fireEvent.click(screen.getByRole("button", { name: "誘う" }));
    act(() => vi.advanceTimersByTime(100));
    const button = screen.getByRole("button", { name: "誘う" });
    expect(button).not.toHaveAttribute("aria-disabled");
    const failed = screen.getByText("送れませんでした。もう一度お試しください");
    expect(failed.className).toContain("text-ink-muted");
    expect(next).not.toHaveBeenCalled();
  });

  it("done のあいだにアンマウントされたら、次へ進まない", () => {
    stubReducedMotion(false);
    const next = vi.fn();
    const { unmount } = render(<Harness next={next} />);
    fireEvent.click(screen.getByRole("button", { name: "誘う" }));
    act(() => vi.advanceTimersByTime(100));
    unmount();
    act(() => vi.advanceTimersByTime(SENT_HOLD_MS * 2));
    expect(next).not.toHaveBeenCalled();
  });

  it("入力がそろっていないときは灰色の押せないボタン", () => {
    render(
      <SubmitButton state="ready" sending="送っています…" done="送りました" disabled>
        誘う
      </SubmitButton>,
    );
    expect(screen.getByRole("button", { name: "誘う" })).toBeDisabled();
  });
});
