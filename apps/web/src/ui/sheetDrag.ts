// シートの引っぱりの判定（docs/specs/T-56-motion.md「M-02」）。純粋な関数だけを置く

/** これ未満しか動かさずに離したら、引っぱりではなくタップ */
export const TAP_SLOP_PX = 10;
/** シートの高さのこの割合以上を下へ引いて離したら閉じる */
const CLOSE_RATIO = 0.3;
/** 離す直前の下向きの速さ（px/ms）がこれ以上なら、短くても閉じる（はじく） */
const FLING_PX_PER_MS = 0.5;
/** 速さを測る、離す直前の時間（ms） */
export const VELOCITY_WINDOW_MS = 100;

export type DragOrigin = "grip" | "header";
export type DragOutcome = "tap" | "close" | "settle";

/**
 * 離したときに、閉じる・戻る・タップのどれにするか。
 * moved：離した位置 − 押した位置（下が正）。maxMoved：押した位置から一番離れた距離（絶対値）。
 * velocity：離す直前の100msの下向きの速さ（px/ms）。height：シートの高さ（px）
 */
export function sheetDragOutcome({
  origin,
  moved,
  maxMoved,
  velocity,
  height,
}: {
  origin: DragOrigin;
  moved: number;
  maxMoved: number;
  velocity: number;
  height: number;
}): DragOutcome {
  // 見出しの行から始めたタップは何もしない（軽く触っただけで閉じることを増やさない）
  if (maxMoved < TAP_SLOP_PX) return origin === "grip" ? "tap" : "settle";
  if (moved >= height * CLOSE_RATIO || (moved > 0 && velocity >= FLING_PX_PER_MS)) return "close";
  return "settle";
}

/** 引いている間にシートへ当てる移動量。上へ引くとゴムのように1/3だけ動く */
export function sheetDragOffset(moved: number): number {
  return moved >= 0 ? moved : moved / 3;
}

export type DragSample = { t: number; y: number };

/** 離す直前の100msの下向きの速さ（px/ms）。その間の一番古い位置から離した位置までで測る。時間が取れなければ0 */
export function dragVelocity(samples: readonly DragSample[], now: number, y: number): number {
  const from = samples.find((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (!from) return 0;
  const dt = now - from.t;
  return dt > 0 ? (y - from.y) / dt : 0;
}
