// 制定日・改定日の行の検査（docs/specs/T-19-privacy-terms.md「5.」）。文字列だけを受け取る純粋な関数（node:fs を使わない）。
// テストは apps/api/test/effective-date.test.ts（Workers の project）で行う

/** ビルドした画面の JS に入る「制定日：」の数（apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE が1つだけ） */
export const EXPECTED_EFFECTIVE_DATE_LINES = 1;
/** 「改定日：」の数の上限（初めて改定したときに REVISION_DATE_LINE を1つ足す。それまでは0） */
export const MAX_REVISION_DATE_LINES = 1;

const DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;

/** 暦にある日付か（2026年13月40日・2026年2月30日などは偽）。Date で作り直して、年月日が同じかで確かめる */
export function isCalendarDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const count = (text, label) => text.split(label).length - 1;

/** label（「制定日：」など）に、暦にある本物の日付（YYYY年M月D日）が続く数 */
function countRealDates(text, label) {
  const re = new RegExp(`${label}${DATE.source}`, "g");
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (isCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]))) n += 1;
  }
  return n;
}

/** 「制定日：」の数 */
export const countEffectiveDateLines = (text) => count(text, "制定日：");
/** 「制定日：」に本物の日付が続く数 */
export const countRealEffectiveDates = (text) => countRealDates(text, "制定日：");
/** 「改定日：」の数 */
export const countRevisionDateLines = (text) => count(text, "改定日：");
/** 「改定日：」に本物の日付が続く数 */
export const countRealRevisionDates = (text) => countRealDates(text, "改定日：");

const sum = (texts, f) => texts.reduce((n, t) => n + f(t), 0);

/**
 * dist の JS の中身（ファイルごとの文字列）を調べ、問題の説明を返す（なければ空）。
 * いつも：「制定日：」がちょうど1回、「改定日：」は0回か1回。deploy が真なら、どちらも本物の日付であることを求める
 */
export function effectiveDateProblems(texts, { deploy }) {
  const problems = [];
  const lines = sum(texts, countEffectiveDateLines);
  if (lines !== EXPECTED_EFFECTIVE_DATE_LINES) {
    problems.push(`「制定日：」が ${lines} 回あります（${EXPECTED_EFFECTIVE_DATE_LINES} 回のはず。apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE を1つの文字列で使う）`);
  } else if (deploy && sum(texts, countRealEffectiveDates) !== lines) {
    problems.push("制定日が決まっていません（apps/web/src/pages/legal.ts の EFFECTIVE_DATE_LINE を「制定日：YYYY年M月D日」の、暦にある日付にする）");
  }
  const revisions = sum(texts, countRevisionDateLines);
  if (revisions > MAX_REVISION_DATE_LINES) {
    problems.push(`「改定日：」が ${revisions} 回あります（${MAX_REVISION_DATE_LINES} 回まで。apps/web/src/pages/legal.ts の REVISION_DATE_LINE を1つの文字列で使う）`);
  } else if (deploy && sum(texts, countRealRevisionDates) !== revisions) {
    problems.push("改定日が日付になっていません（apps/web/src/pages/legal.ts の REVISION_DATE_LINE を「改定日：YYYY年M月D日」の、暦にある日付にする）");
  }
  return problems;
}
