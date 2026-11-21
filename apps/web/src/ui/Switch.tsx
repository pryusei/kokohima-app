import type { ReactNode } from "react";

// スイッチ（デザインシステム「Switch」）。中身は role="switch" のチェックボックス。オンは action の面
// 本物のチェックボックスを見た目のつまみの上に透明に重ね、押した場所がそのままチェックボックスになるようにする

type Props = { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode; description?: ReactNode };

export function Switch({ checked, onChange, disabled, children, description }: Props) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {description && <span className="text-s text-ink-muted">{description}</span>}
      </span>
      <span className="relative h-7 w-12 shrink-0">
        <input
          type="checkbox"
          role="switch"
          className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-line-strong bg-surface-sunken transition-colors peer-checked:border-action peer-checked:bg-action peer-focus-visible:shadow-[0_0_0_2px_var(--color-surface),0_0_0_4px_var(--color-focus)] after:absolute after:top-[3px] after:left-[3px] after:size-5 after:rounded-full after:bg-surface after:shadow-card after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-on-action"
        />
      </span>
    </label>
  );
}
