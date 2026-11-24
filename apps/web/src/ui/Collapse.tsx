import { useEffect, useRef, useState, type ReactNode } from "react";
import { MOTION_MS, prefersReducedMotion, useExitAnimation } from "./motion";

// 高さの開閉（docs/specs/T-56-motion.md「0-4. 高さの開閉の部品 Collapse」）。
// grid-template-rows を 0fr ↔ 1fr、中身の opacity を 0 ↔ 1 にする（height: auto への transition は Safari・Firefox で動かないので使わない）。
// 開く：--duration-base・--ease-out。閉じる：--duration-fast・--ease-in。閉じる動きのあいだは中身を描き続け、終わったら描かない。
// 最初の描画では動かさない。閉じている途中と閉じたあとは、中身を inert にする。
// 入れ物は as で li にもできる（一覧の行。M-10）。閉じ終わったら onHidden を呼ぶ（呼び出し側が入れ物ごと外すため）

type Props = { show: boolean; children: ReactNode; as?: "div" | "li"; className?: string; onHidden?: () => void };

export function Collapse({ show, children, as: Tag = "div", className, onHidden }: Props) {
  const { start, cancel, ref } = useExitAnimation<HTMLElement>(MOTION_MS.fast);
  const [rendered, setRendered] = useState(show);
  // 開くときは、閉じた見た目（0fr）の入れ物のまま中身を描き、同じ描画で開いた側へ替える
  if (show && !rendered) setRendered(true);
  const hidden = useRef(onHidden);
  useEffect(() => {
    hidden.current = onHidden;
  }, [onHidden]);

  useEffect(() => {
    // 閉じる途中で show が true に戻ったら（送れなかったときの戻し）、中身を消さずに開いた見た目へ戻す
    if (show) cancel();
    else if (rendered)
      start(() => {
        setRendered(false);
        hidden.current?.();
      });
  }, [show, rendered, start, cancel]);

  return (
    <Tag ref={ref as never} className={`kh-collapse${className ? ` ${className}` : ""}`} data-closed={show ? undefined : ""}>
      <div inert={!show}>{rendered ? children : null}</div>
    </Tag>
  );
}

/**
 * 描いたあとで開く（入る動き）ための show。最初は false で、次の描き直しの前（2回あとのフレーム）に true にする。
 * ready が false のあいだは待つ（シートが閉じ終わるのを待つ、など）。動きを止める設定では、ready になったらすぐ true
 */
export function useAppear(ready = true): boolean {
  const [shown, setShown] = useState(() => ready && prefersReducedMotion());
  // 動きを止める設定では、ready になった描画でそのまま開く
  const instant = ready && !shown && prefersReducedMotion();
  if (instant) setShown(true);
  useEffect(() => {
    if (shown || !ready || instant) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [shown, ready, instant]);
  return shown;
}
