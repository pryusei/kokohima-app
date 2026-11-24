import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { goBack, swappedSheetHeight } from "../router";
import { OfflineBanner } from "./feedback";
import { MOTION_MS, prefersReducedMotion, useExitAnimation } from "./motion";
import { dragVelocity, sheetDragOffset, sheetDragOutcome, type DragOrigin, type DragSample } from "./sheetDrag";
import { useDesktop } from "./useDesktop";

// 下から出るシート（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「BottomSheet」）
// 右上の「閉じる」のボタン、つまみを押す・下に引く、見出しの行を下に引く、後ろの暗い部分を押す、Esc で閉じる。確認のダイアログは出さない。
// つまみとタイトルの行は、中をスクロールしても上に残す。つまみは見た目の手がかりなので、読み上げと Tab からは外す（「閉じる」は1つだけ）
// 開いている間はフォーカスをシートの中（とシートの上に重ねた結果の帯）に閉じ込め、閉じたら開いたボタンに戻す。
// PC（幅1024px以上）では画面の中央のダイアログにし、つまみを隠す（docs/specs/T-20-desktop-layout.md「シート」）。
// シートは body の直下に描き、開いている間はアプリの本体（#root）を inert にする（URL を持たないシートでも、後ろに Tab で入れないように）
// 出入りの動き（docs/specs/T-56-motion.md「M-01」）：入るのは CSS（index.css の .kh-sheet・@starting-style）。
// 閉じる操作では onClose をすぐ呼ばず、出る動き（data-exiting）を走らせてから1回だけ呼ぶ。動きを止める設定（jsdom を含む）では即時。
// 引っぱり（M-02）：つまみと見出しの行を引くと、シートが指についてくる（スマホだけ）
// 差し替え（M-03）：swapSheet で作成から詳細へ移ったときは、入る動きを走らせず、前のシートの高さのまま描き始め、
// 読み込み中が終わったら、測った中身の高さ（px）へ縮める。height: auto への transition は使わない（Safari・Firefox で動かない）

/** シートの上に重ねる結果の帯（ResultBand.tsx）。Tab の循環に入れる */
const RESULT_BAND = '[data-testid="result-band"]';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** 見出しの行の中で、押し込みを引っぱりにしないもの（ボタン・リンクとして働く） */
const PRESSABLE = 'button, a[href], [role="button"], input, select, textarea';
/** シートの出る動きのうち一番長いもの（スマホのシートが下へ抜ける --duration-base） */
const EXIT_MS = MOTION_MS.base;
/** 離して元へ戻す動き（--duration-base）のあと、data-drag を外すまで */
const SETTLE_MS = MOTION_MS.base + 50;

type Drag = { pointerId: number; startY: number; origin: DragOrigin; maxMoved: number; samples: DragSample[]; height: number };

// シートが閉じる途中か（閉じる操作のあと、onClose を呼ぶまでの出る動きのあいだも true）。
// 送信中に閉じたら、成功しても詳細へ移らない（T-11）ことを、出る動きの途中にも守るため
const SheetLeavingContext = createContext<() => boolean>(() => false);

/** シートの中から、そのシートが閉じる操作のあとかを確かめる関数を返す（シートの外では常に false） */
export const useSheetLeaving = () => useContext(SheetLeavingContext);

/** 読み込み中の骨組み（feedback.tsx の Loading）が中身にあるか */
const isLoading = (el: HTMLElement) => el.querySelector('[role="status"][aria-label="読み込み中"]') !== null;

type Props = {
  title: ReactNode;
  label: string;
  onClose: () => void;
  /** true になったら、閉じる操作と同じに出る動き（M-01）を走らせてから onClose を呼ぶ（送れたあとに閉じる。M-03） */
  dismiss?: boolean;
  children: ReactNode;
};

export function BottomSheet({ title, label, onClose, dismiss = false, children }: Props) {
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
  // 差し替えの前のシートの高さ（M-03）。最初の描画で1回だけ読む。動きを止める設定では使わない（高さも中身も即時）
  const [swapFrom] = useState(() => (prefersReducedMotion() ? null : swappedSheetHeight()));
  // hold＝前の高さのまま（読み込み中）、reveal＝測った高さへ縮めている、null＝ふつう
  const [swap, setSwap] = useState<"hold" | "reveal" | null>(swapFrom === null ? null : "hold");

  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  }, [onClose]);
  // 引いている見た目（data-drag・直接当てた transform と濃さ）を外す。閉じる操作はどれも、ここから出る動きを始める
  // （data-drag が残ると、index.css で出る動きの指定より後ろにある data-drag の指定が勝ってしまう）
  const clearDrag = useCallback(() => {
    drag.current = null;
    window.clearTimeout(settleTimer.current);
    if (scrim.current) delete scrim.current.dataset.drag;
    dialog.current?.style.removeProperty("transform");
    if (backdrop.current) backdrop.current.style.opacity = "";
  }, [dialog]);
  const requestClose = useCallback(() => {
    // 閉じる操作のあとは、出る動きのあいだも onClose のあと外れるまでも、何もしない（goBack が2回にならないように）
    if (leaving.current) return;
    leaving.current = true;
    clearDrag();
    start(() => {
      setGone(true);
      latestClose.current();
    });
  }, [start, clearDrag]);
  const isLeaving = useCallback(() => leaving.current, []);
  useEffect(() => {
    if (dismiss) requestClose();
  }, [dismiss, requestClose]);

  // 差し替え（M-03）：描く前に前の高さを当てる。読み込み中が終わった最初の描画のあと、中身の大きさが決まったら（ResizeObserver）、
  // 中身の高さ（max-h の上限まで）を測って、前の高さから縮める。終わったら（保険のタイマー）高さの指定を外す
  useLayoutEffect(() => {
    if (swapFrom !== null) dialog.current?.style.setProperty("height", `${swapFrom}px`);
  }, [swapFrom, dialog]);
  useLayoutEffect(() => {
    // 毎回の描画のあとに、読み込み中が終わったかを見る（中身は呼び出し側が描くので、印は DOM で確かめる）
    const el = dialog.current;
    if (swap === "hold" && el && !isLoading(el)) setSwap("reveal");
  }, [swap, dialog, children]);
  useLayoutEffect(() => {
    const el = dialog.current;
    if (swap !== "reveal" || swapFrom === null || !el) return;
    let timer: number | undefined;
    const shrink = () => {
      el.style.removeProperty("height");
      const to = el.offsetHeight;
      el.style.setProperty("height", `${swapFrom}px`);
      // 前の高さを描いたことにしてから、測った高さへ（同じフレームで替えると transition にならない）
      void el.offsetHeight;
      el.style.setProperty("height", `${to}px`);
      timer = window.setTimeout(() => {
        el.style.removeProperty("height");
        setSwap(null);
      }, MOTION_MS.sheet + 50);
    };
    if (typeof ResizeObserver === "undefined") {
      shrink();
      return () => window.clearTimeout(timer);
    }
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      shrink();
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [swap, swapFrom, dialog]);

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

  // Tab はシートの中と、シートの上に重ねた結果の帯（M-09。body の直下）の「取り消す」のあいだで回す。
  // 帯はシートの外にあるので、帯にフォーカスがあるときの Tab も受けられるよう文書全体で受ける
  useEffect(() => {
    const onTab = (e: globalThis.KeyboardEvent) => {
      const sheet = dialog.current;
      if (e.key !== "Tab" || !sheet) return;
      const band = document.querySelector<HTMLElement>(RESULT_BAND);
      const active = document.activeElement;
      const inSheet = active instanceof Node && sheet.contains(active);
      const inBand = band !== null && active instanceof Node && band.contains(active);
      if (!inSheet && !inBand) return;
      const inside = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const extra = band ? [...band.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
      const items = [...inside, ...extra];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      let next: HTMLElement | undefined;
      if (e.shiftKey) {
        if (active === first || active === sheet) next = last;
        else if (inBand && active === extra[0]) next = inside[inside.length - 1] ?? last;
      } else if (active === last) next = first;
      else if (inSheet && active === inside[inside.length - 1]) next = extra[0];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    document.addEventListener("keydown", onTab);
    return () => document.removeEventListener("keydown", onTab);
  }, [dialog]);

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
    // 引いている間に触れた2本めの指（drag.current がある）・マウスの左以外のボタンでは引っぱりにしない
    if (desktop || animating || leaving.current || e.button > 0 || drag.current) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(PRESSABLE)) return;
    const origin: DragOrigin = target?.closest('[data-testid="sheet-grip"]') ? "grip" : "header";
    const now = performance.now();
    drag.current = { pointerId: e.pointerId, startY: e.clientY, origin, maxMoved: 0, samples: [{ t: now, y: e.clientY }], height: dialog.current?.offsetHeight ?? 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHeaderMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const now = performance.now();
    const moved = e.clientY - d.startY;
    d.maxMoved = Math.max(d.maxMoved, Math.abs(moved));
    d.samples = [...d.samples.filter((s) => now - s.t <= 100), { t: now, y: e.clientY }];
    if (scrim.current) scrim.current.dataset.drag = "dragging";
    paintDrag(sheetDragOffset(moved), d.height);
  };
  const onHeaderUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
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
    // 閉じる：今の位置から、出る動きを続ける（requestClose が直接当てた transform を外すと同時に data-exiting が付く）
    requestClose();
  };
  const onHeaderCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || e.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    settle();
  };

  const exiting = animating || gone;
  return createPortal(
    <div
      ref={scrim}
      data-testid="sheet-scrim"
      data-exiting={exiting ? "" : undefined}
      data-swap={swap ?? undefined}
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
        className="kh-sheet relative mx-auto flex max-h-[92dvh] w-full max-w-md flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-sheet bg-surface px-6 pt-2 pb-[max(24px,env(safe-area-inset-bottom))] shadow-sheet lg:max-h-[88dvh] lg:max-w-lg lg:rounded-sheet lg:pb-6 lg:shadow-float"
      >
        {/* つまみと見出しの行（つかんで引ける。帯の中のボタン・リンクから始めた押し込みは引っぱりにしない） */}
        <div
          data-testid="sheet-header"
          className="kh-sheet-header sticky top-0 z-10 -mx-6 -mt-2 flex touch-none flex-col gap-2 bg-surface px-6 pt-2 pb-1"
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
          <OfflineBanner gap="s" />
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
