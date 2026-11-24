import { useEffect, useState, type ReactNode } from "react";
import { MOTION_MS, useExitAnimation } from "./motion";

// 高さの開閉（docs/specs/T-56-motion.md「0-4. 高さの開閉の部品 Collapse」）。
// grid-template-rows を 0fr ↔ 1fr、中身の opacity を 0 ↔ 1 にする（height: auto への transition は Safari・Firefox で動かないので使わない）。
// 開く：--duration-base・--ease-out。閉じる：--duration-fast・--ease-in。閉じる動きのあいだは中身を描き続け、終わったら描かない。
// 最初の描画では動かさない。閉じている途中と閉じたあとは、中身を inert にする

export function Collapse({ show, children }: { show: boolean; children: ReactNode }) {
  const { start, cancel, ref } = useExitAnimation<HTMLDivElement>(MOTION_MS.fast);
  const [rendered, setRendered] = useState(show);
  // 開くときは、閉じた見た目（0fr）の入れ物のまま中身を描き、同じ描画で開いた側へ替える
  if (show && !rendered) setRendered(true);

  useEffect(() => {
    // 閉じる途中で show が true に戻ったら（送れなかったときの戻し）、中身を消さずに開いた見た目へ戻す
    if (show) cancel();
    else if (rendered) start(() => setRendered(false));
  }, [show, rendered, start, cancel]);

  return (
    <div ref={ref} className="kh-collapse" data-closed={show ? undefined : ""}>
      <div inert={!show}>{rendered ? children : null}</div>
    </div>
  );
}
