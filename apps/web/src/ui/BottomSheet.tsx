import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { goBack } from "../router";
import { OfflineBanner } from "./feedback";
import { MOTION_MS, useExitAnimation } from "./motion";
import { dragVelocity, sheetDragOffset, sheetDragOutcome, type DragOrigin, type DragSample } from "./sheetDrag";
import { useDesktop } from "./useDesktop";

// 下から出るシート（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「BottomSheet」）
// 右上の「閉じる」のボタン、つまみを押す・下に引く、見出しの行を下に引く、後ろの暗い部分を押す、Esc で閉じる。確認のダイアログは出さない。
// つまみとタイトルの行は、中をスクロールしても上に残す。つまみは見た目の手がかりなので、読み上げと Tab からは外す（「閉じる」は1つだけ）
// 開いている間はフォーカスをシートの中に閉じ込め、閉じたら開いたボタンに戻す。
// PC（幅1024px以上）では画面の中央のダイアログにし、つまみを隠す（docs/specs/T-20-desktop-layout.md「シート」）。
// シートは body の直下に描き、開いている間はアプリの本体（#root）を inert にする（URL を持たないシートでも、後ろに Tab で入れないように）
// 出入りの動き（docs/specs/T-56-motion.md「M-01」）：入るのは CSS（index.css の .kh-sheet・@starting-style）。
// 閉じる操作では onClose をすぐ呼ばず、出る動き（data-exiting）を走らせてから1回だけ呼ぶ。動きを止める設定（jsdom を含む）では即時。
// 引っぱり（M-02）：つまみと見出しの行を引くと、シートが指についてくる（スマホだけ）

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** 見出しの行の中で、押し込みを引っぱりにしないもの（ボタン・リンクとして働く） */
const PRESSABLE = 'button, a[href], [role="button"], input, select, textarea';
/** シートの出る動きのうち一番長いもの（スマホのシートが下へ抜ける --duration-base） */
const EXIT_MS = MOTION_MS.base;
/** 離して元へ戻す動き（--duration-base）のあと、data-drag を外すまで */
const SETTLE_MS = MOTION_MS.base + 50;

type Drag = { startY: number; origin: DragOrigin; maxMoved: number; samples: DragSample[]; height: number };

// シートが閉じる途中か（閉じる操作のあと、onClose を呼ぶまでの出る動きのあいだも true）。
// 送信中に閉じたら、成功しても詳細へ移らない（T-11）ことを、出る動きの途中にも守るため
const SheetLeavingContext = createContext<() => boolean>(() => false);

/** シートの中から、そのシートが閉じる操作のあとかを確かめる関数を返す（シートの外では常に false） */
export const useSheetLeaving = () => useContext(SheetLeavingContext);

type Props = { title: ReactNode; label: string; onClose: () => void; children: ReactNode };

export function BottomSheet({ title, label, onClose, children }: Props) {
  const { exiting: animating, start, ref: dialog } = useExitAnimation<HTMLDivElement>(EXIT_MS);
  const scrim = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const settleTimer = useRef<number | undefined>(undefined);
  const pressedOnScrim = useRef(false);
  const leaving = useRef(false);
  // onClose を呼んだあと、外す（アンマウント）までは、出た形のまま描く（goBack は popstate が後から届くので、その間に戻って見えないように）
  const [gone, setGone] = useState(false);
  const desktop = useDesktop();

  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  }, [onClose]);
  const requestClose = useCallback(() => {
    leaving.current = true;
    start(() => {
      setGone(true);
      latestClose.current();
    });
  }, [start]);
  const isLeaving = useCallback(() => leaving.current, []);

  // Esc は、押したボタンが送信中に押せなくなってフォーカスがシートの外（body）に出たときも効くように、文書全体で受ける
  const close = useRef(requestClose);
  useEffect(() => {
    close.current = requestClose;
  }, [requestClose]);
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
      window.clearTimeout(settleTimer.current);
      if (root) root.inert = wasInert;
      if (opener?.isConnected) opener.focus();
    };
  }, [opener, dialog]);

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

  // 引いている間の見た目は、描き直さずに要素へ直接当てる（指の動きごとに React で描き直さない）
  const paintDrag = (offset: number | null, height: number) => {
    dialog.current?.style.setProperty("transform", offset === null ? "" : `translateY(${offset}px)`);
    if (backdrop.current) {
      backdrop.current.style.opacity = offset === null ? "" : String(1 - Math.min(Math.max(height > 0 ? offset / height : 0, 0), 1));
    }
  };
  const settle = () => {
    const el = scrim.current;
    if (el) el.dataset.drag = "settling";
    paintDrag(null, 0);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      if (scrim.current?.dataset.drag === "settling") delete scrim.current.dataset.drag;
    }, SETTLE_MS);
  };

  // つまみと見出しの行を押す・引く（M-02）。マウスでも外で離したときに pointerup が届くように、pointer を捕まえる。
  // 閉じるのは pointerup の1か所だけにする。onClick でも閉じると、引いたあとに届く click で onClose が2回呼ばれ、history.back() が2回になる
  const onHeaderDown = (e: PointerEvent<HTMLDivElement>) => {
    if (desktop || animating) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(PRESSABLE)) return;
    const origin: DragOrigin = target?.closest('[data-testid="sheet-grip"]') ? "grip" : "header";
    const now = performance.now();
    drag.current = { startY: e.clientY, origin, maxMoved: 0, samples: [{ t: now, y: e.clientY }], height: dialog.current?.offsetHeight ?? 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHeaderMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const moved = e.clientY - d.startY;
    d.maxMoved = Math.max(d.maxMoved, Math.abs(moved));
    d.samples = [...d.samples.filter((s) => now - s.t <= 100), { t: now, y: e.clientY }];
    if (scrim.current) scrim.current.dataset.drag = "dragging";
    paintDrag(sheetDragOffset(moved), d.height);
  };
  const onHeaderUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const moved = e.clientY - d.startY;
    const outcome = sheetDragOutcome({
      origin: d.origin,
      moved,
      maxMoved: Math.max(d.maxMoved, Math.abs(moved)),
      velocity: dragVelocity(d.samples, performance.now(), e.clientY),
      height: d.height,
    });
    if (outcome === "settle") {
      settle();
      return;
    }
    // 閉じる：今の位置から、出る動きを続ける（直接当てた transform を外すと同時に data-exiting が付く）
    if (scrim.current) delete scrim.current.dataset.drag;
    paintDrag(null, 0);
    requestClose();
  };
  const onHeaderCancel = () => {
    if (!drag.current) return;
    drag.current = null;
    settle();
  };

  const exiting = animating || gone;
  return createPortal(
    <div
      ref={scrim}
      data-testid="sheet-scrim"
      data-exiting={exiting ? "" : undefined}
      className="kh-sheet-scrim fixed inset-0 z-30 flex flex-col justify-end lg:items-center lg:justify-center lg:p-6"
      // 押し始めも離したのも暗い部分のときだけ閉じる（シートの中で文字を選んで外で離したときに閉じない）
      onPointerDown={(e) => {
        pressedOnScrim.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOnScrim.current) requestClose();
        pressedOnScrim.current = false;
      }}
    >
      {/* 暗い背景は別の層にする（薄くする・濃さを変えるのはこの層だけ。シートはこの層の子ではないので一緒に薄くならない）。押す判定は暗幕の要素が受ける */}
      <div ref={backdrop} aria-hidden="true" data-testid="sheet-backdrop" className="kh-sheet-backdrop pointer-events-none absolute inset-0 bg-scrim" />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="kh-sheet relative mx-auto flex max-h-[92dvh] w-full max-w-md flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-sheet bg-surface px-6 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] shadow-sheet lg:max-h-[88dvh] lg:max-w-lg lg:rounded-sheet lg:pb-6 lg:shadow-float"
      >
        {/* つまみと見出しの行（つかんで引ける。帯の中のボタン・リンクから始めた押し込みは引っぱりにしない） */}
        <div
          data-testid="sheet-header"
          className="sticky top-0 z-10 -mx-6 -mt-2 flex touch-none flex-col gap-2 bg-surface px-6 pt-2 pb-1"
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          onPointerCancel={onHeaderCancel}
        >
          {/* つまみ（押す・下に引くと閉じる）。読み上げと Tab では右上の「閉じる」を使う */}
          <div
            aria-hidden="true"
            data-testid="sheet-grip"
            className="mx-auto grid h-6 w-16 shrink-0 cursor-pointer place-items-center rounded-full lg:hidden"
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
              onClick={requestClose}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
        </div>
        <SheetLeavingContext.Provider value={isLeaving}>{children}</SheetLeavingContext.Provider>
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
