import type { ReactNode } from "react";

// 返答のボタン群と募集の人数（デザインシステム「ResponseButtons」「HeadCount」）

/** 1つめ（主ボタン）を横いっぱい、残りを2列に並べる */
export function ResponseButtons({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 [&>:first-child]:col-span-2">{children}</div>;
}

/** 募集者にだけ見せる、応じた人の数。名前は出さない。0人なら「まだ応じた人はいません」 */
export function HeadCount({ count }: { count: number }) {
  if (count <= 0) {
    return <p className="text-ink-muted">まだ応じた人はいません</p>;
  }
  return (
    <p className="flex items-baseline gap-2">
      <span className="text-xxl leading-tight font-bold tabular-nums">{count}</span>
      <span>人が応じています</span>
    </p>
  );
}
