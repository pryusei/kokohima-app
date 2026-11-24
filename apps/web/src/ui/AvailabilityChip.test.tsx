import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AvailabilityChip, forgetLitLamps } from "./AvailabilityChip";

// 「重なっています」の灯りが、一回だけともる（docs/specs/T-56-motion.md「M-12」、テスト計画「実装PR②」）

const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

/** 動きを止める設定（matches）を差し替える */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

/** IntersectionObserver の差し替え。enter(el) でその要素が画面に入ったことにする */
const observers: { callback: IntersectionObserverCallback; targets: Element[]; options?: IntersectionObserverInit }[] = [];
function stubIntersectionObserver() {
  class FakeObserver {
    entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.entry = { callback, targets: [], options };
      observers.push(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.push(el);
    }
    disconnect() {
      this.entry.targets = [];
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
}
const visibility = (el: Element, isIntersecting: boolean) =>
  act(() => {
    for (const o of observers.filter((o) => o.targets.includes(el))) {
      o.callback([{ target: el, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });

const chip = (text: string) => screen.getByText(text).closest("[data-overlaps], .kh-lamp") as HTMLElement;

beforeEach(() => {
  observers.length = 0;
  forgetLitLamps();
});
afterEach(() => vi.unstubAllGlobals());

describe("重なる枠の灯り", () => {
  it("止めない設定で、重なる枠が画面に（半分以上）入ったら1回だけ灯る印が付く", () => {
    stubReducedMotion(false);
    stubIntersectionObserver();
    render(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    const el = chip("夜 19:00〜23:00");
    // 画面に入るまでは灯る前の形で待つ
    expect(el).toHaveAttribute("data-lamp", "wait");
    expect(el).not.toHaveClass("animate-kh-lamp-on");
    expect(observers[0]?.options?.threshold).toBe(0.5);
    visibility(el, false);
    expect(el).toHaveAttribute("data-lamp", "wait");
    visibility(el, true);
    expect(el).toHaveAttribute("data-lamp", "on");
    expect(el).toHaveClass("animate-kh-lamp-on", "bg-lamp", "shadow-lamp");
  });

  it("同じ枠は、描き直しても・見えなくなってまた入っても・ほかのタブから戻って描き直しても、もう一度灯らない", () => {
    stubReducedMotion(false);
    stubIntersectionObserver();
    const { rerender, unmount } = render(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    const el = chip("夜 19:00〜23:00");
    visibility(el, true);
    rerender(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    visibility(el, false);
    visibility(el, true);
    // 一度灯したら見張るのをやめる（灯す印はそのまま、灯り直さない）
    expect(observers.every((o) => o.targets.length === 0)).toBe(true);
    expect(observers).toHaveLength(1);
    unmount();
    render(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    const again = chip("夜 19:00〜23:00");
    expect(again).not.toHaveAttribute("data-lamp");
    expect(again).not.toHaveClass("animate-kh-lamp-on");
    expect(again).toHaveClass("bg-lamp", "shadow-lamp");
  });

  it("重ならない枠には付けない（見えなくなった枠・相手ごとにも違う動きをしない）", () => {
    stubReducedMotion(false);
    stubIntersectionObserver();
    render(<AvailabilityChip text="昼 11:00〜15:00" lampKey="a|3|4" />);
    const el = chip("昼 11:00〜15:00");
    expect(el).not.toHaveAttribute("data-lamp");
    expect(observers).toHaveLength(0);
  });

  it("動きを止める設定・IntersectionObserver がない環境では、最初から灯った見た目", () => {
    stubReducedMotion(true);
    stubIntersectionObserver();
    const { unmount } = render(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    expect(chip("夜 19:00〜23:00")).not.toHaveAttribute("data-lamp");
    expect(chip("夜 19:00〜23:00")).toHaveClass("bg-lamp", "shadow-lamp");
    unmount();
    vi.unstubAllGlobals();
    stubReducedMotion(false);
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<AvailabilityChip text="夜 19:00〜23:00" overlaps lampKey="a|1|2" />);
    expect(chip("夜 19:00〜23:00")).not.toHaveAttribute("data-lamp");
    expect(chip("夜 19:00〜23:00")).toHaveClass("bg-lamp", "shadow-lamp");
  });

  it("灯る動きは 500ms・ease-out の一回だけ（infinite にしない）。待つ形は動きを止める設定では使わない", () => {
    expect(css).toMatch(/--animate-kh-lamp-on: kh-lamp-on 500ms var\(--ease-out\) backwards;/);
    expect(css).toMatch(/@keyframes kh-lamp-on\s*\{\s*from\s*\{/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.kh-lamp\[data-lamp="wait"\]/);
    expect(css).not.toMatch(/kh-lamp-on[^;]*infinite/);
  });
});
