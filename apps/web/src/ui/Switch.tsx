import type { ReactNode } from "react";

// スイッチ（デザインシステム「Switch」）。中身は role="switch" のチェックボックス。オンは action の面

type Props = { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode; description?: ReactNode };

export function Switch({ checked, onChange, disabled, children, description }: Props) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {description && <span className="text-s text-ink-muted">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative h-7 w-12 shrink-0 rounded-full border border-line-strong bg-surface-sunken transition-colors peer-checked:border-action peer-checked:bg-action peer-focus-visible:shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-focus)] after:absolute after:top-[3px] after:left-[3px] after:size-5 after:rounded-full after:bg-surface after:shadow-card after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-on-action"
      />
    </label>
  );
}
