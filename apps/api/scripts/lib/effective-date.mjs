// 制定日の行の検査（docs/specs/T-19-privacy-terms.md「5.」）。文字列だけを受け取る純粋な関数（node:fs を使わない）。
// テストは apps/api/test/effective-date.test.ts（Workers の project）で行う

/** ビルドした画面の JS に入る「制定日：」の数（apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE が1つだけ） */
export const EXPECTED_EFFECTIVE_DATE_LINES = 1;

/** 「制定日：」の数 */
export function countEffectiveDateLines(text) {
  return text.split("制定日：").length - 1;
}

/** 「制定日：」に本物の日付（YYYY年M月D日）が続く数 */
export function countRealEffectiveDates(text) {
  return (text.match(/制定日：\d{4}年\d{1,2}月\d{1,2}日/g) ?? []).length;
}

/**
 * dist の JS の中身（ファイルごとの文字列）を調べ、問題の説明を返す（なければ空）。
 * deploy が真なら、本物の日付であることも求める
 */
export function effectiveDateProblems(texts, { deploy }) {
  const lines = texts.reduce((n, t) => n + countEffectiveDateLines(t), 0);
  const problems = [];
  if (lines !== EXPECTED_EFFECTIVE_DATE_LINES) {
    problems.push(`「制定日：」が ${lines} 回あります（${EXPECTED_EFFECTIVE_DATE_LINES} 回のはず。apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE を1つの文字列で使う）`);
  } else if (deploy) {
    const real = texts.reduce((n, t) => n + countRealEffectiveDates(t), 0);
    if (real !== EXPECTED_EFFECTIVE_DATE_LINES) {
      problems.push("制定日が決まっていません（apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE を「制定日：YYYY年M月D日」にする）");
    }
  }
  return problems;
}
