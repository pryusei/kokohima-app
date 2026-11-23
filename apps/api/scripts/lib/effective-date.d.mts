export declare const EXPECTED_EFFECTIVE_DATE_LINES: number;
export declare const MAX_REVISION_DATE_LINES: number;
export declare function isCalendarDate(year: number, month: number, day: number): boolean;
export declare function countEffectiveDateLines(text: string): number;
export declare function countRealEffectiveDates(text: string): number;
export declare function countRevisionDateLines(text: string): number;
export declare function countRealRevisionDates(text: string): number;
export declare function effectiveDateProblems(texts: string[], options: { deploy: boolean }): string[];
