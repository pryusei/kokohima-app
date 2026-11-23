import type { Wish } from "@kokohima/shared";
import type { ReactNode } from "react";
import { LinkCard } from "../ui/LinkCard";

// 行きたい1件のカード（docs/specs/T-22-wishlist.md「画面」）。ひとこと・エリア・リンク。文字列はテキストとして出す

export function WishCard({ wish, actions }: { wish: Wish; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
      <p className="whitespace-pre-line font-bold">{wish.message}</p>
      {wish.area && <p className="text-s text-ink-muted">エリア：{wish.area}</p>}
      <LinkCard url={wish.url} preview={wish.linkPreview} />
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
