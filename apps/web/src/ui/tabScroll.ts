// スクロールの位置（docs/specs/T-56-motion.md「M-07」）。どれもメモリだけに持つ（localStorage・sessionStorage に置かない）。
// タブの位置はタブの URL（pathname。誘いタブは ?tab= によらず1つ）ごと、履歴のエントリの位置はエントリの印（key）ごと

export type ScrollPositions = ReadonlyMap<string, number>;

/** タブを離れるときの位置を覚えた、新しい表 */
export function rememberTabScroll(positions: ScrollPositions, from: string, y: number): ScrollPositions {
  return new Map(positions).set(from, y);
}

/** タブへ移るときの位置。初めてなら一番上（0） */
export function tabScrollTarget(positions: ScrollPositions, to: string): number {
  return positions.get(to) ?? 0;
}

/**
 * ブラウザの戻る・進む（popstate）で移った先の位置。
 * そのエントリの位置があればそれ、なければ（タブなら）タブの位置、どちらもなければ一番上
 */
export function scrollTargetOnPop(
  entryPositions: ScrollPositions,
  tabPositions: ScrollPositions,
  to: { key: string | null; tab: string | null },
): number {
  if (to.key !== null) {
    const y = entryPositions.get(to.key);
    if (y !== undefined) return y;
  }
  if (to.tab !== null) return tabScrollTarget(tabPositions, to.tab);
  return 0;
}
