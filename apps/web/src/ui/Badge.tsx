import type { ReactNode } from "react";

// 状態のバッジ（デザインシステム「Badge」）。色は4つだけ。断り・期限切れ・見送り・締め切りはどれも quiet（赤を使わない）

export type Tone = "meet" | "pending" | "lamp" | "quiet";

const TONE: Record<Tone, string> = {
  meet: "bg-meet text-on-meet font-bold",
  pending: "border border-line-strong bg-transparent text-ink font-bold",
  lamp: "bg-lamp-soft text-ink font-bold",
  quiet: "bg-quiet-bg text-quiet-ink",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span data-tone={tone} className={`inline-flex shrink-0 items-center rounded-s px-2 text-s leading-6 ${TONE[tone]}`}>
      {children}
    </span>
  );
}
