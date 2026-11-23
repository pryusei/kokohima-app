import type { ReactNode } from "react";

// 入力欄（デザインシステムの入力欄・SlotChips）。押せる部品は44px以上

// min-w-0 と max-w-full：日付・時刻の入力欄がシートの幅をはみ出さないように抑える（iPhone の Safari の分は index.css）
export const inputClass = "min-h-11 w-full min-w-0 max-w-full rounded-s border border-line-strong bg-surface-sunken px-3 text-m font-normal text-ink";

/** ラベルの見た目（入力欄を中に入れる） */
export const labelClass = "flex min-w-0 flex-1 flex-col gap-1 text-xs font-bold text-ink-muted";

/** ラベルと入力欄。ラベルは小さな太字（micro） */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className={labelClass}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** 日付・時間帯などのチップ。選んでいるものは action の面 */
export function Chip({ selected = false, onClick, children }: { selected?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-9 rounded-full border px-3.5 tabular-nums ${selected ? "border-action bg-action text-on-action" : "border-line bg-surface text-ink"}`}
    >
      {children}
    </button>
  );
}

export function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-bold text-ink-muted">{label}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** 複数行の入力欄（inputClass に複数行の分を足したもの。幅の指定 min-w-0・max-w-full を含む） */
export const textareaClass = `${inputClass} py-2 min-h-40 resize-y leading-normal`;

/** 文字数（「count / max」）。超えたら超えた数の文にする。色は赤にせず、超えたときだけ読み上げる（aria-live="polite"） */
export function CharCount({ count, max }: { count: number; max: number }) {
  const over = count - max;
  const text = over > 0 ? `${max}文字までです（${over}文字多い）` : `${count} / ${max}`;
  return (
    <div className="text-right text-xs text-ink-muted tabular-nums">
      <span aria-hidden={over > 0 ? true : undefined}>{text}</span>
      <span className="sr-only" aria-live="polite">
        {over > 0 ? text : ""}
      </span>
    </div>
  );
}
