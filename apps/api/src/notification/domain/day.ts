/** 利用者のタイムゾーンでの日付（YYYY-MM-DD）。1日の上限の区切りに使う */
export function localDay(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(instant),
  );
}
