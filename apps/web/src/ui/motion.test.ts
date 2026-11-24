import { act, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_MS, prefersReducedMotion, useExitAnimation } from "./motion";

// 動きのトークンと部品（docs/specs/T-56-motion.md「0-2.」「0-3.」、テスト計画「実装PR①」）

// CSS の ?raw は vitest では空になるので、ファイルを直接読む
const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 動きを止める設定（matches）を差し替える */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("動きのトークン", () => {
  const themeStatic = /@theme static\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const duration = (name: string) => Number(new RegExp(`--duration-${name}:\\s*(\\d+)ms;`).exec(themeStatic)?.[1]);

  it("index.css の --duration-* と MOTION_MS の値が一致する", () => {
    for (const [name, ms] of Object.entries(MOTION_MS)) expect(duration(name), name).toBe(ms);
    expect(themeStatic.match(/--duration-/g)).toHaveLength(Object.keys(MOTION_MS).length);
  });

  it("出る動きのトークンは入る動きの1段下で、7割前後の長さになっている", () => {
    // sheet で入るものは base、base は fast、fast は press で出る
    for (const [enter, leave] of [
      [MOTION_MS.sheet, MOTION_MS.base],
      [MOTION_MS.base, MOTION_MS.fast],
      [MOTION_MS.fast, MOTION_MS.press],
    ] as const) {
      expect(leave / enter).toBeGreaterThanOrEqual(0.6);
      expect(leave / enter).toBeLessThanOrEqual(0.7);
    }
  });

  it("曲線は @theme に置き、ばねの曲線は linear() で、使えない端末では ease-out にする", () => {
    expect(css).toMatch(/--ease-out:\s*cubic-bezier\(0\.2, 0\.8, 0\.2, 1\);/);
    expect(css).toMatch(/--ease-in:\s*cubic-bezier\(0\.4, 0, 1, 1\);/);
    expect(css).toMatch(/--ease-spring:\s*linear\(0, 0\.13 4%, .*1 75%, 1\);/);
    expect(css).toMatch(/@supports not \(transition-timing-function: linear\(0, 1\)\)\s*\{\s*:root\s*\{\s*--ease-spring:\s*var\(--ease-out\);/);
  });
});

describe("動きの長さと曲線の直書きがない（docs/specs/T-56-motion.md「0-1. の5」）", () => {
  /** クラスでの直書き：duration-100・duration-[…]・ease-[…]・animate-[…]・delay-[…] */
  const CLASS_LITERAL = /(?:^|[\s"'`:])(?:duration-(?:\d|\[)|ease-\[|animate-\[|delay-\[)[^\s"'`]*/g;
  /** Tailwind の transition・transition-* のクラス */
  const TRANSITION = /(?:^|[\s"'`:])transition(?:-[a-z]+)?(?=[\s"'`]|$)/;
  /** クラスの文字列（className="…" と、文字列の定数） */
  const CLASS_STRINGS = /(["'`])((?:(?!\1).)*\btransition\b(?:(?!\1).)*)\1/g;
  // M-18（実装PR③）でスイッチの動きをトークンにするまで、スイッチだけは今の Tailwind の既定の長さのまま
  const PENDING = new Set(["./Switch.tsx"]);

  it("クラスに長さ・曲線・アニメーションの直書きがない", () => {
    const found = Object.entries(sources).flatMap(([path, text]) => (text.match(CLASS_LITERAL) ?? []).map((m) => `${path}: ${m.trim()}`));
    expect(found).toEqual([]);
  });

  it("transition・transition-* のクラスには、長さのトークン（duration-(--duration-*)）を付けている", () => {
    const found = Object.entries(sources)
      .filter(([path]) => !PENDING.has(path))
      .flatMap(([path, text]) =>
        [...text.matchAll(CLASS_STRINGS)]
          .map((m) => m[2] ?? "")
          .filter((cls) => TRANSITION.test(cls) && !/duration-\(--duration-(?:press|fast|base|sheet)\)/.test(cls))
          .map((cls) => `${path}: ${cls}`),
      );
    expect(found).toEqual([]);
  });

  it("index.css に秒・ミリ秒の数を直書きしない（トークンの定義と T-43 の成立の演出、M-12 の灯りの 500ms だけを除く）", () => {
    const rest = withoutBlocks(css, [/@theme static\s*\{/, /\.kh-meet-(?:dot|pair|reveal)\s*\{/, /@keyframes kh-meet-[\w-]+\s*\{/]).replace(
      "--animate-kh-lamp-on: kh-lamp-on 500ms",
      "",
    );
    // コメントの中の数（「約1.2秒」など）は数えない
    const code = rest.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code.match(/(?<![\w-])\d*\.?\d+m?s\b/g)).toBeNull();
  });

  it("Button と今ひまのボタンの transition-transform は --duration-press で書く", () => {
    for (const path of ["./Button.tsx", "../availability/FreeNowCard.tsx"]) {
      expect(sources[path], path).toMatch(/transition-transform duration-\(--duration-press\) ease-out/);
    }
  });

  it("検査が直書きを見つけられる", () => {
    expect(' className="duration-300 ease-[cubic-bezier(0,0,1,1)] animate-[kh-pop_.35s_ease-out] delay-[50ms]"'.match(CLASS_LITERAL)).toHaveLength(4);
    expect(' className="duration-(--duration-fast) ease-out ease-spring"'.match(CLASS_LITERAL)).toBeNull();
    expect(TRANSITION.test("rounded transition-colors")).toBe(true);
    expect(TRANSITION.test("kh-sheet-transition")).toBe(false);
    expect(withoutBlocks(".a{x:1}.kh-meet-dot{animation: y 1200ms}.b{y:2}", [/\.kh-meet-dot\s*\{/])).toBe(".a{x:1}.b{y:2}");
  });
});

/** start の正規表現で始まる `{ … }` のかたまり（入れ子の括弧を含む）を除く */
function withoutBlocks(text: string, starts: RegExp[]) {
  let out = text;
  for (const start of starts) {
    const global = new RegExp(start.source, "g");
    let m: RegExpExecArray | null;
    while ((m = global.exec(out))) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < out.length && depth > 0) {
        if (out[i] === "{") depth++;
        else if (out[i] === "}") depth--;
        i++;
      }
      out = out.slice(0, m.index) + out.slice(i);
      global.lastIndex = m.index;
    }
  }
  return out;
}

describe("prefersReducedMotion", () => {
  it("matchMedia がないと true（即時）、あれば matches のとおり", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(true);
    stubReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    stubReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("useExitAnimation", () => {
  beforeEach(() => vi.useFakeTimers());

  /** ref に要素を付けたフック。child は ref の要素の子 */
  function setup(duration = 240) {
    const hook = renderHook(() => useExitAnimation<HTMLDivElement>(duration));
    const el = document.createElement("div");
    const child = document.createElement("span");
    el.append(child);
    document.body.append(el);
    hook.result.current.ref.current = el;
    return { hook, el, child };
  }

  it("動きを止める設定では、start の中で即時に done を1回呼ぶ", () => {
    stubReducedMotion(true);
    const { hook } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    expect(done).toHaveBeenCalledTimes(1);
    expect(hook.result.current.exiting).toBe(false);
  });

  it("matchMedia がない（jsdom の既定）なら即時", () => {
    const { hook } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("止めない設定では、長さ＋50msまでは呼ばず、＋50msで1回だけ呼ぶ。終わると exiting が false に戻る", () => {
    stubReducedMotion(false);
    const { hook } = setup(240);
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    expect(hook.result.current.exiting).toBe(true);
    act(() => vi.advanceTimersByTime(289));
    expect(done).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(done).toHaveBeenCalledTimes(1);
    expect(hook.result.current.exiting).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("要素自身の transitionend が先に来たらそこで1回だけ呼び、タイマーでは呼ばない。子から泡立ったものでは呼ばない", () => {
    stubReducedMotion(false);
    const { hook, el, child } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    act(() => {
      child.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    expect(done).not.toHaveBeenCalled();
    act(() => {
      el.dispatchEvent(new Event("transitionend", { bubbles: true }));
    });
    expect(done).toHaveBeenCalledTimes(1);
    act(() => {
      el.dispatchEvent(new Event("animationend", { bubbles: true }));
      vi.advanceTimersByTime(1000);
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("要素自身の animationend でも終わる", () => {
    stubReducedMotion(false);
    const { hook, el } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    act(() => {
      el.dispatchEvent(new Event("animationend"));
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("途中で start をもう一度呼んでも、done は1回だけ（二度押し）", () => {
    stubReducedMotion(false);
    const { hook } = setup();
    const first = vi.fn();
    const second = vi.fn();
    act(() => hook.result.current.start(first));
    act(() => hook.result.current.start(second));
    act(() => vi.advanceTimersByTime(290));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("途中でアンマウントしたら done を呼ばない", () => {
    stubReducedMotion(false);
    const { hook, el } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    hook.unmount();
    act(() => {
      el.dispatchEvent(new Event("transitionend"));
      vi.advanceTimersByTime(1000);
    });
    expect(done).not.toHaveBeenCalled();
  });

  it("done のあと、もう一度 start すると、また1回だけ done を呼ぶ（閉じて開いてもう一度閉じる）", () => {
    stubReducedMotion(false);
    const { hook } = setup();
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    act(() => vi.advanceTimersByTime(290));
    act(() => hook.result.current.start(done));
    expect(hook.result.current.exiting).toBe(true);
    act(() => vi.advanceTimersByTime(290));
    expect(done).toHaveBeenCalledTimes(2);
  });

  it("途中で cancel すると、done は呼ばれず（タイマーが過ぎても）、exiting が false に戻る。途中でなければ何もしない", () => {
    stubReducedMotion(false);
    const { hook, el } = setup();
    act(() => hook.result.current.cancel());
    expect(hook.result.current.exiting).toBe(false);
    const done = vi.fn();
    act(() => hook.result.current.start(done));
    act(() => hook.result.current.cancel());
    expect(hook.result.current.exiting).toBe(false);
    act(() => {
      el.dispatchEvent(new Event("transitionend"));
      vi.advanceTimersByTime(1000);
    });
    expect(done).not.toHaveBeenCalled();
    // cancel のあとも、また start できる
    act(() => hook.result.current.start(done));
    act(() => vi.advanceTimersByTime(290));
    expect(done).toHaveBeenCalledTimes(1);
  });
});
