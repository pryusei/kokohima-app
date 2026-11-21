// ここ暇の枠のチップ（デザインシステム「AvailabilityChip」）。灯り（lamp）は自分と重なる枠にだけ付ける
// 見せない相手と暇がない相手は、どちらも何も出さない（灰色の枠で「見せない」を示さない）

type Props = { text: string; overlaps?: boolean; recurring?: boolean };

export function AvailabilityChip({ text, overlaps = false, recurring = false }: Props) {
  const look = overlaps ? "border-lamp bg-lamp text-on-lamp shadow-lamp" : "border-lamp-line bg-lamp-soft text-ink";
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span
        data-overlaps={overlaps || undefined}
        className={`inline-flex items-baseline gap-2 rounded-full border px-3.5 py-1 tabular-nums ${look} ${recurring ? "border-dashed" : ""}`}
      >
        {text}
        {recurring && <span className="text-xs text-ink-muted">くり返し</span>}
      </span>
      {overlaps && <span className="text-s text-ink-muted">自分のここ暇と重なっています</span>}
    </span>
  );
}
