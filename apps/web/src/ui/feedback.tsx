import type { ReactNode } from "react";
import { Button } from "./Button";
import { useOnline } from "./online";

// 空の状態・読み込み中・読み込めない・オフライン（デザインシステム「EmptyState」「StatusStates」）。操作の結果は ResultBand.tsx
// どれも赤や警告の印を使わず、surface-sunken の静かな帯で出す

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span aria-hidden="true" className="relative h-16 w-14 rounded-t-l rounded-b-s border-2 border-line-strong bg-surface-sunken">
        <span className="absolute inset-2.5 rounded-s bg-lamp-soft" />
      </span>
      <p className="text-l font-bold">{title}</p>
      {description && <p className="text-s text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}

/** 読み込み中：カードの形の骨組み。くるくる回る印は使わない */
export function Loading() {
  return (
    <div role="status" aria-label="読み込み中" className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
      <span className="h-3.5 w-2/5 rounded-s bg-surface-sunken" />
      <span className="h-3.5 w-3/4 rounded-s bg-surface-sunken" />
      <span className="h-3.5 w-full rounded-s bg-surface-sunken" />
    </div>
  );
}

/** 読み込めないとき。retry があれば「もう一度」を出す */
export function LoadError({
  text = "読み込めませんでした。もう一度お試しください",
  retry,
  retrySize = "s",
}: {
  text?: string;
  retry?: () => void;
  /** 「もう一度」の大きさ。その画面の操作が「もう一度」だけのときは m（docs/specs/T-49-perf-small-fixes.md「4.」） */
  retrySize?: "s" | "m";
}) {
  return (
    <div className="flex items-center gap-3 rounded-m bg-surface-sunken px-4 py-3">
      <p role="status" className="min-w-0 flex-1">
        {text}
      </p>
      {retry && (
        <Button size={retrySize} onClick={retry}>
          もう一度
        </Button>
      )}
    </div>
  );
}

/** オフラインの帯（docs/specs/T-11-design.md「オフライン」） */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="flex items-center gap-3 rounded-m bg-surface-sunken px-4 py-3">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink-muted" />
      <p role="status" className="min-w-0 flex-1">
        オフラインです。つながると最新の内容になります
      </p>
    </div>
  );
}

/** 補助の説明 */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-s text-ink-muted">{children}</p>;
}
