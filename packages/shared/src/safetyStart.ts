import safetyStart from "./safetyStart.json";

// ブロックと通報を始める日（docs/specs/T-33-block-report.md「振る舞い 8.」）。
// 値は safetyStart.json の1か所。プライバシー ポリシーの改定日（効力が生じる日。apps/web/src/pages/legal.ts の REVISION_DATE_LINE）と同じ日にする。
// デプロイの検査（apps/api/scripts/lib/effective-date.mjs の safetyStartProblems）も同じ JSON を読む

const START_DATE: string | null = (safetyStart as { startDate: string | null }).startDate;

/** startDate の日本時間の0時（Unix ミリ秒）。未定（null）なら null */
export function safetyStartAt(startDate: string | null = START_DATE): number | null {
  if (startDate === null) return null;
  const at = Date.parse(`${startDate}T00:00:00+09:00`);
  return Number.isNaN(at) ? null : at;
}

/** 始める日を過ぎたか。startAt が null ならいつも閉じている */
export const isSafetyOpen = (now: number, startAt: number | null) => startAt !== null && now >= startAt;
