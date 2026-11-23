export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}
export declare const EXPECTED_EFFECTIVE_DATE_LINES: number;
export declare const MAX_REVISION_DATE_LINES: number;
export declare const MAX_REVISION_NOTICE_LINES: number;
export declare const MIN_NOTICE_DAYS: number;
export declare const MAX_NOTICE_DAYS: number;
export declare const EFFECTIVE_DATE_LABEL: string;
export declare const REVISION_DATE_LABEL: string;
export declare const REVISION_NOTICE_LABEL: string;
export declare const OLD_REVISION_DATE_LABEL: string;
export declare function isCalendarDate(year: number, month: number, day: number): boolean;
export declare function daysBetween(a: CalendarDay, b: CalendarDay): number;
export declare function countEffectiveDateLines(text: string): number;
export declare function countRealEffectiveDates(text: string): number;
export declare function countRevisionDateLines(text: string): number;
export declare function countRealRevisionDates(text: string): number;
export declare function countRevisionNoticeLines(text: string): number;
export declare function countRealRevisionNoticeDates(text: string): number;
export declare function countOldRevisionDateLines(text: string): number;
export declare function effectiveDateProblems(
  texts: string[],
  options: { deploy: boolean; today?: CalendarDay; noticeAlreadyPublished?: boolean },
): string[];
export declare function revisionNoticeLine(texts: string[]): string | null;
export declare function contactStartProblems(
  texts: string[],
  options: { startDate: unknown; deploy: boolean; today?: CalendarDay },
): string[];
export declare function jstToday(now: number): CalendarDay;
