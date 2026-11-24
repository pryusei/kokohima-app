import type { ReactNode } from "react";

// 状態のバッジ（デザインシステム「Badge」）。色は4つだけ。断り・期限切れ・見送り・締め切りはどれも quiet（赤を使わない）

export type Tone = "meet" | "pending" | "lamp" | "quiet";

const TONE: Record<Tone, string> = {
  meet: "bg-meet text-on-meet font-bold",
  pending: "border border-line-strong bg-transparent text-ink font-bold",
  lamp: "bg-lamp-soft text-ink font-bold",
  quiet: "bg-quiet-bg text-quiet-ink",
};

/** pop：自分の操作で成立したときに1回だけ「ぽん」とする（docs/specs/T-56-motion.md「M-04」。meet のときだけ効く） */
export function Badge({ tone, pop = false, children }: { tone: Tone; pop?: boolean; children: ReactNode }) {
  const popping = pop && tone === "meet";
  return (
    <span
      data-tone={tone}
      data-pop={popping || undefined}
      className={`inline-flex shrink-0 items-center rounded-s px-2 text-s leading-6 ${TONE[tone]} ${popping ? "animate-kh-badge-pop" : ""}`}
    >
      {children}
    </span>
  );
}
