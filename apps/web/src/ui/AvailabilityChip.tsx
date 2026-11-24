import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./motion";

// ここ暇の枠のチップ（デザインシステム「AvailabilityChip」）。灯り（lamp）は自分と重なる枠にだけ付ける
// 見せない相手と暇がない相手は、どちらも何も出さない（灰色の枠で「見せない」を示さない）
// 重なる枠は、初めて画面に（半分以上）入ったときに一回だけ灯る（docs/specs/T-56-motion.md「M-12」）。
// 灯した枠の印はメモリだけに持つ（スクロールで出入りしても・ほかのタブから戻っても、もう一度灯さない。開き直したら、また一回）

type Props = {
  text: string;
  overlaps?: boolean;
  recurring?: boolean;
  /** 一回だけ灯す判定の印（友達の ID ＋開始・終了の時刻）。ないときは灯す動きを付けない */
  lampKey?: string;
};

const litLamps = new Set<string>();

/** テストのために、灯した枠の印を消す */
export const forgetLitLamps = () => litLamps.clear();

/** "wait"＝画面に入るのを待つ（灯る前の形）、"on"＝灯る動き、null＝最初から灯った形 */
function useLampOn(lampKey: string | undefined, overlaps: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<"wait" | "on" | null>(() =>
    overlaps && lampKey !== undefined && !litLamps.has(lampKey) && !prefersReducedMotion() && typeof IntersectionObserver !== "undefined"
      ? "wait"
      : null,
  );
  useEffect(() => {
    const el = ref.current;
    if (phase !== "wait" || !el || lampKey === undefined) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        litLamps.add(lampKey);
        setPhase("on");
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [phase, lampKey]);
  // 重ならなくなったら、動きの印を付けない
  return { ref, phase: overlaps ? phase : null };
}

export function AvailabilityChip({ text, overlaps = false, recurring = false, lampKey }: Props) {
  const { ref, phase } = useLampOn(lampKey, overlaps);
  const look = overlaps ? "border-lamp bg-lamp text-on-lamp shadow-lamp" : "border-lamp-line bg-lamp-soft text-ink";
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span
        ref={ref}
        data-overlaps={overlaps || undefined}
        data-lamp={phase ?? undefined}
        className={`kh-lamp inline-flex items-baseline gap-2 rounded-full border px-3.5 py-1 tabular-nums ${look} ${recurring ? "border-dashed" : ""} ${
          phase === "on" ? "animate-kh-lamp-on" : ""
        }`}
      >
        {text}
        {recurring && <span className="text-xs text-ink-muted">くり返し</span>}
      </span>
      {overlaps && <span className="text-s text-ink-muted">自分のここ暇と重なっています</span>}
    </span>
  );
}
