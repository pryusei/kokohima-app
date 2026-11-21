import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { goBack } from "../router";
import { OfflineBanner } from "./feedback";

// 下から出るシート（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「BottomSheet」）
// つまみを押す・下に引く、後ろの暗い部分を押す、Esc で閉じる。確認のダイアログは出さない。
// 開いている間はフォーカスをシートの中に閉じ込め、閉じたら開いたボタンに戻す

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DRAG_CLOSE_PX = 60;

type Props = { title: ReactNode; label: string; onClose: () => void; children: ReactNode };

export function BottomSheet({ title, label, onClose, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialog.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    dragFrom.current = e.clientY;
  };
  const onPointerUp = (e: PointerEvent) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from !== null && e.clientY - from >= DRAG_CLOSE_PX) onClose();
  };

  return (
    <div
      data-testid="sheet-scrim"
      className="fixed inset-0 z-30 flex flex-col justify-end bg-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="mx-auto flex max-h-[92dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-sheet bg-surface px-6 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] shadow-sheet"
      >
        <button
          type="button"
          aria-label="閉じる"
          className="mx-auto grid h-6 w-16 shrink-0 touch-none place-items-center rounded-full"
          onClick={onClose}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-line-strong" />
        </button>
        <OfflineBanner />
        {typeof title === "string" ? <h2 className="text-xl font-bold">{title}</h2> : title}
        {children}
      </div>
    </div>
  );
}

/** URL を持つシート。閉じると、アプリの中から開いたときだけ戻り、それ以外は後ろのタブへ移る */
export function SheetScreen({ title, label, parent, children }: { title: ReactNode; label: string; parent: string; children: ReactNode }) {
  return (
    <BottomSheet title={title} label={label} onClose={() => goBack(parent)}>
      {children}
    </BottomSheet>
  );
}
