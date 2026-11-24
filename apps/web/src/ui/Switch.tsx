import type { ReactNode } from "react";
import { useOnline } from "./online";

// スイッチ（デザインシステム「Switch」）。中身は role="switch" のチェックボックス。オンは action の面
// 本物のチェックボックスを見た目のつまみの上に透明に重ね、押した場所がそのままチェックボックスになるようにする
// 切り替えはサーバーへ送る操作なので、オフラインの間は押せなくする（押すと画面だけが変わり、送られないまま閉じられることがある）

type Props = { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; children: ReactNode; description?: ReactNode };

export function Switch({ checked, onChange, disabled, children, description }: Props) {
  const online = useOnline();
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
          disabled={disabled || !online}
          onChange={(e) => onChange(e.target.checked)}
        />
        {/* 動き（docs/specs/T-56-motion.md「M-18」）：地の色は fast、つまみの移動は fast・ばね（フォーカスの輪の outline は transition に含めない）。
            押している間はつまみを横に4px伸ばす（オンのときは左へ伸ばし、右の端の位置を変えない）。押せないときは伸ばさない */}
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full border border-line-strong bg-surface-sunken transition-[background-color,border-color] duration-(--duration-fast) peer-checked:border-action peer-checked:bg-action peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus after:absolute after:top-[3px] after:left-[3px] after:h-5 after:w-5 after:rounded-full after:bg-surface after:shadow-card after:transition-[translate,width,background-color] after:duration-(--duration-fast) after:ease-spring peer-checked:after:translate-x-5 peer-checked:after:bg-on-action peer-enabled:peer-active:after:w-6 peer-enabled:peer-active:peer-checked:after:translate-x-4 peer-disabled:opacity-50"
        />
      </span>
    </label>
  );
}
