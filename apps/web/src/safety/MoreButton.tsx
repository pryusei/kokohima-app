import { useCallback, useRef, useState, type Ref } from "react";

// 相手への操作のシート（docs/specs/T-33-block-report.md「振る舞い 1.」）を開く「…」のボタン。シートの見出しの行に置く

export function MoreButton({ name, onClick, ref }: { name: string; onClick: () => void; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${name}さんへの操作`}
      className="grid size-11 shrink-0 place-items-center rounded-full text-ink-muted"
      onClick={onClick}
    >
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    </button>
  );
}

/**
 * 「…」のシートを開いているか。開くと「…」は消え、PersonActions が自分にフォーカスを移す。
 * 「戻る」で閉じたら、出し直した「…」にフォーカスを戻す（moreRef を MoreButton に渡す）
 */
export function usePersonActionsToggle() {
  const [acting, setActing] = useState(false);
  const refocus = useRef(false);
  const moreRef = useCallback((el: HTMLButtonElement | null) => {
    if (el && refocus.current) {
      refocus.current = false;
      el.focus();
    }
  }, []);
  const open = useCallback(() => setActing(true), []);
  const close = useCallback(() => {
    refocus.current = true;
    setActing(false);
  }, []);
  return { acting, open, close, moreRef };
}
