import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// 動きのトークンと部品（docs/specs/T-56-motion.md「0-2. 動きのトークン」「0-3. 動きの部品」）。
// 値は index.css の @theme static の --duration-* と同じ（motion.test.ts で確かめる）

export const MOTION_MS = { press: 100, fast: 160, base: 240, sheet: 360 } as const;

/** 終わりのイベントが届かないときの保険のタイマーの、動きの長さに足す分 */
const SAFETY_MS = 50;

/**
 * 動きを止める設定か。matchMedia がない環境（jsdom の既定）では true（＝即時）。
 * CSS の動きは index.css の共通の指定で止まるが、JavaScript で動きの終わりを待つところはこれで確かめる
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type ExitAnimation<T extends HTMLElement> = {
  /** 出る動きの途中か。true のあいだ、呼び出し側は data-exiting を付ける */
  exiting: boolean;
  /** 出る動きを走らせてから done を1回だけ呼ぶ。途中なら何もしない */
  start(done: () => void): void;
  /** 出る動きの途中なら、done を呼ばずに元へ戻す */
  cancel(): void;
  /** 一番長い出る動きをする要素に付ける */
  ref: RefObject<T | null>;
};

/**
 * 出る動きを走らせてから、本当に消す（閉じる・外す）ためのフック。
 * 終わりは、ref の要素自身の transitionend・animationend（子から泡立ったものは数えない）か、保険のタイマー（durationMs + 50ms）の早いほう。
 * animationend・transitionend だけを待つと、動きを止める設定と jsdom では届かず永遠に終わらないので、タイマーを必ず置く
 */
export function useExitAnimation<T extends HTMLElement = HTMLElement>(durationMs: number): ExitAnimation<T> {
  const ref = useRef<T>(null);
  const [exiting, setExiting] = useState(false);
  // 途中の出る動きの後片付け（タイマーとイベントを外す）。null なら途中ではない
  const pending = useRef<(() => void) | null>(null);

  const start = useCallback(
    (done: () => void) => {
      if (pending.current) return;
      if (prefersReducedMotion()) {
        done();
        return;
      }
      const el = ref.current;
      const finish = () => {
        pending.current?.();
        pending.current = null;
        setExiting(false);
        done();
      };
      const onEnd = (e: Event) => {
        if (e.target === el) finish();
      };
      el?.addEventListener("transitionend", onEnd);
      el?.addEventListener("animationend", onEnd);
      const timer = window.setTimeout(finish, durationMs + SAFETY_MS);
      pending.current = () => {
        window.clearTimeout(timer);
        el?.removeEventListener("transitionend", onEnd);
        el?.removeEventListener("animationend", onEnd);
      };
      setExiting(true);
    },
    [durationMs],
  );

  const cancel = useCallback(() => {
    if (!pending.current) return;
    pending.current();
    pending.current = null;
    setExiting(false);
  }, []);

  // 途中でアンマウントされたら（ブラウザの戻るで URL が先に変わったときなど）、done は呼ばない（呼ぶと戻るが2回になる）
  useEffect(
    () => () => {
      pending.current?.();
      pending.current = null;
    },
    [],
  );

  return { exiting, start, cancel, ref };
}
