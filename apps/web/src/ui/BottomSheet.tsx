import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { goBack } from "../router";
import { OfflineBanner } from "./feedback";
import { useDesktop } from "./useDesktop";

// 下から出るシート（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「BottomSheet」）
// つまみを押す・下に引く、後ろの暗い部分を押す、Esc で閉じる。確認のダイアログは出さない。
// 開いている間はフォーカスをシートの中に閉じ込め、閉じたら開いたボタンに戻す。
// PC（幅1024px以上）では画面の中央のダイアログにし、つまみの代わりに右上の「閉じる」を出す（docs/specs/T-20-desktop-layout.md「シート」）。
// シートは body の直下に描き、開いている間はアプリの本体（#root）を inert にする（URL を持たないシートでも、後ろに Tab で入れないように）

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DRAG_CLOSE_PX = 60;

type Props = { title: ReactNode; label: string; onClose: () => void; children: ReactNode };

export function BottomSheet({ title, label, onClose, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const pressedOnScrim = useRef(false);
  const desktop = useDesktop();

  // Esc は、押したボタンが送信中に押せなくなってフォーカスがシートの外（body）に出たときも効くように、文書全体で受ける
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  // 開いたボタンは描画の時点で覚える。URL を持つシートは後ろのタブを同じ描画で inert にするので、
  // effect の時点ではブラウザがフォーカスを外していて（body になる）、戻す先がわからなくなる
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  useEffect(() => {
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    dialog.current?.focus();
    const onEscape = (e: globalThis.KeyboardEvent) => {
      // 日本語入力の変換を取り消す Esc では閉じない
      if (e.key === "Escape" && !e.isComposing) close.current();
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      if (root) root.inert = wasInert;
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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

  // つまみを下に引いて閉じる。マウスでもつまみの外で離したときに pointerup が届くように、pointer を捕まえる
  const onGripDown = (e: PointerEvent<HTMLButtonElement>) => {
    dragFrom.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripUp = (e: PointerEvent<HTMLButtonElement>) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    // PC の配置では下に引いて閉じない（押せば閉じる）
    if (!desktop && from !== null && e.clientY - from >= DRAG_CLOSE_PX) onClose();
  };

  return createPortal(
    <div
      data-testid="sheet-scrim"
      className="fixed inset-0 z-30 flex flex-col justify-end bg-scrim lg:items-center lg:justify-center lg:p-6"
      // 押し始めも離したのも暗い部分のときだけ閉じる（シートの中で文字を選んで外で離したときに閉じない）
      onPointerDown={(e) => {
        pressedOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnScrim.current) onClose();
        pressedOnScrim.current = false;
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative mx-auto flex max-h-[92dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-sheet bg-surface px-6 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] shadow-sheet lg:max-h-[88dvh] lg:max-w-lg lg:rounded-sheet lg:pt-14 lg:pb-6 lg:shadow-float"
      >
        <button
          type="button"
          aria-label="閉じる"
          className="mx-auto grid h-6 w-16 shrink-0 touch-none place-items-center rounded-full lg:absolute lg:top-3 lg:right-3 lg:size-11 lg:text-ink-muted lg:hover:bg-surface-sunken"
          onClick={onClose}
          onPointerDown={onGripDown}
          onPointerUp={onGripUp}
        >
          <span aria-hidden="true" className="h-1 w-9 rounded-full bg-line-strong lg:hidden" />
          <svg aria-hidden="true" className="hidden lg:block" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        <OfflineBanner />
        {typeof title === "string" ? <h2 className="text-xl font-bold">{title}</h2> : title}
        {children}
      </div>
    </div>,
    document.body,
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
