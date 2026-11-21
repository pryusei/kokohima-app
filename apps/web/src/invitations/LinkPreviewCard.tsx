import type { LinkPreview } from "@kokohima/shared";
import { linkLabel } from "./format";

// 誘い・募集・予定のリンク（docs/specs/T-08-link-preview.md「画面（仮）」）。
// status が ok ならカード、それ以外（pending・failed・null）は今と同じドメインだけ。pending に「読み込み中」は出さない。
// ドメインは必ず linkHostname（punycode）で出し、siteName で置き換えない。文字列はテキストとして出す

export function LinkPreviewCard({ url, preview }: { url: string | null; preview: LinkPreview | null }) {
  const host = linkLabel(url);
  if (!url || !host) return null;
  const link = { href: url, target: "_blank", rel: "noopener noreferrer nofollow" } as const;
  if (preview?.status !== "ok") {
    return (
      <a {...link} className="underline">
        {host}
      </a>
    );
  }
  return (
    <a {...link} className="flex flex-col overflow-hidden rounded-lg border" aria-label={`${preview.title ?? host}（${host}）`}>
      {preview.imageUrl && (
        <img src={preview.imageUrl} loading="lazy" referrerPolicy="no-referrer" alt="" className="max-h-48 w-full object-cover" />
      )}
      <span className="flex flex-col gap-1 p-3">
        {preview.title && <span className="font-bold">{preview.title}</span>}
        {preview.description && <span className="text-sm text-slate-700">{preview.description}</span>}
        <span className="text-xs text-slate-500">{host}</span>
      </span>
    </a>
  );
}
