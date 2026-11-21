// 友達のアイコン（デザインシステム「Avatar」）。画像の登録はまだないので、表示名の1文字め。名前がなければ「？」
// 色で人を区別しない（全員 surface-sunken）

const SIZE = { s: "size-7 text-s", m: "size-10", l: "size-16 text-xl" } as const;

export function Avatar({ name, size = "m" }: { name: string | null; size?: keyof typeof SIZE }) {
  const initial = name ? Array.from(name.trim())[0] ?? "？" : "？";
  return (
    <span aria-hidden="true" className={`inline-grid shrink-0 place-items-center rounded-full bg-surface-sunken font-bold text-ink ${SIZE[size]}`}>
      {initial}
    </span>
  );
}
