// 相手への操作のシート（docs/specs/T-33-block-report.md「振る舞い 1.」）を開く「…」のボタン。シートの見出しの行に置く

export function MoreButton({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <button
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
