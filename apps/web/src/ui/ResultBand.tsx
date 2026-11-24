import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MOTION_MS, useExitAnimation } from "./motion";

// 結果の帯（docs/specs/T-56-motion.md「M-09」。T-55 の UndoToast をアプリに1つにしたもの。デザインシステム「Toast」）
// 操作のすぐあとに、下のタブ（スマホ）の上・左のナビの右（PC）に数秒出す一文と「取り消す」。中身を押し下げない（position: fixed）。
// シートを開いているときもシートの上に重ねる（body の直下に描く。シートの後ろの #root は inert なので、その中に置くと押せない）。
// 成功も失敗も同じ見た目（赤を使わない）。指やマウスを乗せている間・フォーカスがある間は消さない。
// context に渡すのは変わらない show だけ。帯の文言・タイマーはこの部品の中だけで持つ（show を呼んでも、使う画面は描き直されない）

/** 「取り消す」があるものを出しておく長さ（T-55） */
export const UNDO_TOAST_MS = 6000;
/** 文だけのものを出しておく長さ */
export const RESULT_BAND_MS = 3500;

export type BandMessage = { text: string; undo?: () => void };
type Shown = BandMessage & { id: number };

type Show = (message: BandMessage) => void;

const noop: Show = () => {};
const ShowContext = createContext<Show>(noop);

/** 結果の帯を出す関数。帯を出しても、この関数を使う部品は描き直されない */
export const useResultBand = () => useContext(ShowContext);

export function ResultBandProvider({ children }: { children: ReactNode }) {
  const setter = useRef<Show>(noop);
  const show = useCallback<Show>((message) => setter.current(message), []);
  return (
    <ShowContext.Provider value={show}>
      {children}
      <ResultBand registerRef={setter} />
    </ShowContext.Provider>
  );
}

/** 読み上げの場所（live region）はいつも置いておき、中身だけを入れ替える */
function ResultBand({ registerRef }: { registerRef: RefObject<Show> }) {
  const [message, setMessage] = useState<Shown | null>(null);
  const nextIdRef = useRef(0);
  const { exiting, start, cancel, ref } = useExitAnimation<HTMLDivElement>(MOTION_MS.fast);
  useLayoutEffect(() => {
    registerRef.current = (m) => {
      // 新しい結果は、今の帯を差し替えて入る動きからもう一度出す（同じ文でも作り直す）
      cancel();
      setMessage({ ...m, id: ++nextIdRef.current });
    };
    return () => {
      registerRef.current = noop;
    };
  }, [registerRef, cancel]);

  const [held, setHeld] = useState(false);
  // 「取り消す」は一度だけ（続けて押しても戻す操作を2回送らない）
  const [usedId, setUsedId] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 一文を出したときにフォーカスがあった場所（押したマスなど）。「取り消す」が消えたら、そこへ戻す
  const origin = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  const id = message?.id;
  const hasUndo = message?.undo !== undefined;

  useEffect(() => {
    if (id === undefined || held) return;
    const timer = setTimeout(
      () => start(() => setMessage((m) => (m?.id === id ? null : m))),
      hasUndo ? UNDO_TOAST_MS : RESULT_BAND_MS,
    );
    return () => clearTimeout(timer);
  }, [id, held, hasUndo, start]);

  useLayoutEffect(() => {
    if (id === undefined) {
      refocus.current = false;
      return;
    }
    const active = document.activeElement;
    if (refocus.current) {
      // 「取り消す」を押したあとの一文。押したボタンが消えてフォーカスが body に落ちたら、元の場所に戻す
      refocus.current = false;
      if (!active || active === document.body) (origin.current?.isConnected ? origin.current : box.current)?.focus();
      return;
    }
    origin.current = active instanceof HTMLElement && !box.current?.contains(active) ? active : null;
  }, [id]);

  const used = message !== null && usedId === message.id;
  return createPortal(
    <div
      ref={box}
      role="status"
      tabIndex={-1}
      data-testid="result-band"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-40 px-4 lg:bottom-6 lg:left-60"
    >
      {message && (
        <div
          key={message.id}
          ref={ref}
          data-exiting={exiting ? "" : undefined}
          className="kh-fade-exit pointer-events-auto mx-auto flex max-w-md animate-kh-rise items-center justify-between gap-2 rounded-l bg-ink py-1 pr-1 pl-4 text-s text-surface shadow-float lg:mx-0"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span className="min-h-11 content-center">{message.text}</span>
          {message.undo && (
            <button
              type="button"
              aria-disabled={used || undefined}
              className="min-h-11 shrink-0 rounded-m px-3 font-bold text-surface underline underline-offset-4"
              onClick={() => {
                if (used) return;
                setUsedId(message.id);
                setHeld(false);
                refocus.current = true;
                message.undo?.();
              }}
            >
              取り消す
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
