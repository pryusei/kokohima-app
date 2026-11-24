import type { LinkPreview } from "@kokohima/shared";
import { linkLabel } from "../invitations/format";

// リンクのカード（docs/specs/T-08-link-preview.md「画面」、デザインシステム「LinkCard」）。見た目は2つだけ。
// status が ok ならプレビューあり、それ以外（pending・failed・null）はドメインだけ。pending に「読み込み中」は出さない。
// ドメインは必ず linkHostname（punycode）で出し、siteName で置き換えない。文字列はテキストとして出す

// compact：横にめくるカード（ここ暇タブの行きたい。docs/specs/T-55-availability-week-grid.md）では、高さをそろえるため
// 画像を出さず、ドメインだけの形にタイトルを1行で添える

export function LinkCard({ url, preview, compact = false }: { url: string | null; preview: LinkPreview | null; compact?: boolean }) {
  const host = linkLabel(url);
  if (!url || !host) return null;
  const link = { href: url, target: "_blank", rel: "noopener noreferrer nofollow" } as const;
  const title = preview?.status === "ok" ? preview.title : null;
  if (compact) {
    return (
      <a
        {...link}
        className="flex min-w-0 flex-col rounded-l border border-line bg-surface px-3 py-2 text-s no-underline"
        aria-label={title ? `${title}（${host}）` : undefined}
      >
        {title && <span className="truncate font-bold text-ink">{title}</span>}
        <span className="truncate text-ink-muted">{host}</span>
      </a>
    );
  }
  if (preview?.status !== "ok") {
    return (
      <a {...link} className="flex items-center gap-2 rounded-l border border-line bg-surface px-4 py-3 text-s text-ink-muted no-underline">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
          <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
        </svg>
        {host}
      </a>
    );
  }
  return (
    <a
      {...link}
      className="flex flex-col overflow-hidden rounded-l border border-line bg-surface no-underline"
      aria-label={`${preview.title ?? host}（${host}）`}
    >
      {preview.imageUrl && (
        <img src={preview.imageUrl} loading="lazy" referrerPolicy="no-referrer" alt="" className="aspect-[1.91/1] w-full bg-surface-sunken object-cover" />
      )}
      <span className="flex flex-col gap-0.5 px-4 py-3">
        {preview.title && <span className="line-clamp-2 font-bold text-ink">{preview.title}</span>}
        {preview.description && <span className="line-clamp-2 text-s text-ink-muted">{preview.description}</span>}
        <span className="text-s text-ink-muted">{host}</span>
      </span>
    </a>
  );
}
