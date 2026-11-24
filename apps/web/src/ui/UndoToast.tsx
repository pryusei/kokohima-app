import { useEffect, useState } from "react";

// 操作のすぐあとに下に数秒出す一文と「取り消す」（docs/specs/T-55-availability-week-grid.md「振る舞い 3.」、デザインシステム「Toast」）
// 下のタブ（スマホ）の上に重ねる。PC では左のナビの右。成功も失敗も同じ見た目（赤を使わない）
// 指やマウスを乗せている間・フォーカスがある間は消さない（読み終わる前に消えないように）

export const UNDO_TOAST_MS = 6000;

export type ToastMessage = { id: number; text: string; undo?: () => void };

/** 読み上げの場所（live region）はいつも置いておき、中身だけを入れ替える */
export function UndoToast({ message, onDone }: { message: ToastMessage | null; onDone: () => void }) {
  const [held, setHeld] = useState(false);
  const id = message?.id;
  useEffect(() => {
    if (id === undefined || held) return;
    const timer = setTimeout(onDone, UNDO_TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, held, onDone]);

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 px-4 lg:bottom-6 lg:left-60"
    >
      {message && (
        <div
          className="pointer-events-auto mx-auto flex max-w-md items-center justify-between gap-2 rounded-l bg-ink py-1 pr-1 pl-4 text-s text-surface shadow-float motion-safe:animate-[kh-rise_.2s_ease-out] lg:mx-0"
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          <span className="min-h-11 content-center">{message.text}</span>
          {message.undo && (
            <button
              type="button"
              className="min-h-11 shrink-0 rounded-m px-3 font-bold text-surface underline underline-offset-4"
              onClick={() => {
                setHeld(false);
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
