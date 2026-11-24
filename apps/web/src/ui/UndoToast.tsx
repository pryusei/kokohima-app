import { useEffect, useLayoutEffect, useRef, useState } from "react";

// 操作のすぐあとに下に数秒出す一文と「取り消す」（docs/specs/T-55-availability-week-grid.md「振る舞い 3.」、デザインシステム「Toast」）
// 下のタブ（スマホ）の上に重ねる。PC では左のナビの右。成功も失敗も同じ見た目（赤を使わない）
// 指やマウスを乗せている間・フォーカスがある間は消さない（読み終わる前に消えないように）
// inline はシートの中に置くとき（シートの後ろの #root は inert で、下に重ねると押せず読み上げにも届かないため）

export const UNDO_TOAST_MS = 6000;

export type ToastMessage = { id: number; text: string; undo?: () => void };

/** 読み上げの場所（live region）はいつも置いておき、中身だけを入れ替える */
export function UndoToast({ message, onDone, inline = false }: { message: ToastMessage | null; onDone: () => void; inline?: boolean }) {
  const [held, setHeld] = useState(false);
  // 「取り消す」は一度だけ（続けて押しても戻す操作を2回送らない）
  const [usedId, setUsedId] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 一文を出したときにフォーカスがあった場所（押したマスなど）。「取り消す」が消えたら、そこへ戻す
  const origin = useRef<HTMLElement | null>(null);
  const refocus = useRef(false);
  const id = message?.id;

  useEffect(() => {
    if (id === undefined || held) return;
    const timer = setTimeout(onDone, UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, held, onDone]);

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
  return (
    <div
      ref={box}
      role="status"
      tabIndex={-1}
      className={
        inline
          ? ""
          : "pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 px-4 lg:bottom-6 lg:left-60"
      }
    >
      {message && (
        <div
          className={`pointer-events-auto mx-auto flex max-w-md items-center justify-between gap-2 rounded-l bg-ink py-1 pr-1 pl-4 text-s text-surface shadow-float motion-safe:animate-kh-rise ${
            inline ? "" : "lg:mx-0"
          }`}
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
    </div>
  );
}
