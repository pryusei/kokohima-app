import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { goBack } from "../router";
import { OfflineBanner } from "./feedback";

// 下から出るシート（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「BottomSheet」）
// 右上の「閉じる」のボタン、つまみを押す・下に引く、後ろの暗い部分を押す、Esc で閉じる。確認のダイアログは出さない。
// つまみとタイトルの行は、中をスクロールしても上に残す。つまみは見た目の手がかりなので、読み上げと Tab からは外す（「閉じる」は1つだけ）
// 開いている間はフォーカスをシートの中に閉じ込め、閉じたら開いたボタンに戻す。
// PC（幅1024px以上）では画面の中央のダイアログにし、つまみを隠す（docs/specs/T-20-desktop-layout.md「シート」）。
// シートは body の直下に描き、開いている間はアプリの本体（#root）を inert にする（URL を持たないシートでも、後ろに Tab で入れないように）

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DRAG_CLOSE_PX = 60;
const TAP_SLOP_PX = 10;

type Props = { title: ReactNode; label: string; onClose: () => void; children: ReactNode };

export function BottomSheet({ title, label, onClose, children }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const dragFrom = useRef<number | null>(null);
  const pressedOnScrim = useRef(false);

  // Esc は、押したボタンが送信中に押せなくなってフォーカスがシートの外（body）に出たときも効くように、文書全体で受ける
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  // 開いたボタンは、最初の描画のときに覚える。effect の時点では、後ろのタブがもう inert になっていて
  // ブラウザがフォーカスを外しているので（document.activeElement が body になる）、閉じたときに戻せない
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

  // つまみは押す（ほとんど動かさずに離す）か、下に引くと閉じる。マウスでもつまみの外で離したときに pointerup が届くように、pointer を捕まえる。
  // 閉じるのは pointerup の1か所だけにする。onClick でも閉じると、引いたあとに届く click で onClose が2回呼ばれ、history.back() が2回になる
  const onGripDown = (e: PointerEvent<HTMLDivElement>) => {
    dragFrom.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null) return;
    const moved = e.clientY - from;
    if (moved >= DRAG_CLOSE_PX || Math.abs(moved) < TAP_SLOP_PX) onClose();
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
        className="mx-auto flex max-h-[92dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-sheet bg-surface px-6 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] shadow-sheet lg:max-h-[88dvh] lg:max-w-lg lg:rounded-sheet lg:pb-6 lg:shadow-float"
      >
        <div className="sticky top-0 z-10 -mx-6 -mt-2 flex flex-col gap-2 bg-surface px-6 pt-2 pb-1">
          {/* つまみ（押す・下に引くと閉じる）。読み上げと Tab では右上の「閉じる」を使う */}
          <div
            aria-hidden="true"
            data-testid="sheet-grip"
            className="mx-auto grid h-6 w-16 shrink-0 cursor-pointer touch-none place-items-center rounded-full lg:hidden"
            onPointerDown={onGripDown}
            onPointerUp={onGripUp}
            onPointerCancel={() => {
              dragFrom.current = null;
            }}
          >
            <span className="h-1 w-9 rounded-full bg-line-strong" />
          </div>
          {/* オフラインの帯も上に残す（スクロールしても、送る操作が止まっている理由が見える） */}
          <OfflineBanner />
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {typeof title === "string" ? <h2 className="text-xl font-bold">{title}</h2> : title}
            </div>
            <button
              type="button"
              aria-label="閉じる"
              className="-mr-2.5 grid size-11 shrink-0 place-items-center rounded-full text-ink-muted"
              onClick={onClose}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
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
