import { useState } from "react";
import { useOnline } from "./online";

// 友達のアイコン（デザインシステム「Avatar」）。画像（T-27 の署名つき URL）があれば丸く出し、
// なければ・読めなければ（404・期限切れ）表示名の1文字め。名前がなければ「？」
// 色で人を区別しない（全員 surface-sunken）

const SIZE = { s: "size-7 text-s", m: "size-10", l: "size-16 text-xl" } as const;

export function Avatar({ name, src = null, size = "m" }: { name: string | null; src?: string | null; size?: keyof typeof SIZE }) {
  // 読めなかった URL を覚えておく（URL が変われば、もう一度読む）
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // 通信の失敗と404を区別できないので、オンラインに戻ったら読み直す
  // （effect の中で setState しないよう、描画の中で前の値と比べる）
  const online = useOnline();
  const [prevOnline, setPrevOnline] = useState(online);
  if (online !== prevOnline) {
    setPrevOnline(online);
    if (online) setFailedSrc(null);
  }
  const initial = name ? Array.from(name.trim())[0] ?? "？" : "？";
  const showImage = src !== null && src !== failedSrc;
  return (
    <span
      aria-hidden="true"
      className={`inline-grid shrink-0 place-items-center overflow-hidden rounded-full bg-surface-sunken font-bold text-ink ${SIZE[size]}`}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        initial
      )}
    </span>
  );
}
