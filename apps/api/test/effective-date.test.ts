import { describe, expect, it } from "vitest";
import {
  contactStartProblems,
  countEffectiveDateLines,
  countOldRevisionDateLines,
  countRealEffectiveDates,
  countRealRevisionDates,
  countRealRevisionNoticeDates,
  countRevisionDateLines,
  countRevisionNoticeLines,
  daysBetween,
  effectiveDateProblems,
  EXPECTED_EFFECTIVE_DATE_LINES,
  jstToday,
  revisionNoticeLine,
  type CalendarDay,
} from "../scripts/lib/effective-date.mjs";
import chunk from "./fixtures/web-dist-legal.js?raw";
import contactStart from "../../../packages/shared/src/contactStart.json";

// 制定日・改定日・公表日の行の検査（docs/specs/T-19-privacy-terms.md「5.」「8.」）。fixture は vite が圧縮した chunk をまねたもの
const PLACEHOLDER = "制定日：2026年◯月◯日";
const withDate = (date: string) => chunk.replace(PLACEHOLDER, `制定日：${date}`);

describe("制定日の検査", () => {
  it("fixture は仮の値の行を1つだけ持つ", () => {
    expect(chunk).toContain(PLACEHOLDER);
    expect(countEffectiveDateLines(chunk)).toBe(EXPECTED_EFFECTIVE_DATE_LINES);
    expect(countRealEffectiveDates(chunk)).toBe(0);
  });

  it("仮の値：いつもの検査は通り、--deploy では止まる", () => {
    expect(effectiveDateProblems([chunk], { deploy: false })).toEqual([]);
    expect(effectiveDateProblems([chunk], { deploy: true, today: LATE })).toHaveLength(1);
  });

  it("本物の日付：どちらも通る", () => {
    for (const date of ["2026年12月1日", "2027年1月15日"]) {
      const text = withDate(date);
      expect(countRealEffectiveDates(text)).toBe(1);
      expect(effectiveDateProblems([text], { deploy: true, today: LATE })).toEqual([]);
    }
  });

  it("形の違う日付は本物に数えない", () => {
    for (const date of ["2026年12月", "2026/12/1", "26年12月1日", "2026年◯月1日", "2026年13月40日", "2026年2月30日", "2026年0月1日"]) {
      expect(countRealEffectiveDates(withDate(date))).toBe(0);
      expect(effectiveDateProblems([withDate(date)], { deploy: true, today: LATE })).toHaveLength(1);
    }
  });

  it("「制定日：」が0回・2回なら、いつもの検査でも止まる", () => {
    expect(effectiveDateProblems([chunk.replace(PLACEHOLDER, "2026年12月1日")], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([chunk, withDate("2026年12月1日")], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([`${chunk}"制定日："+d`], { deploy: false })).toHaveLength(1);
  });

  it("暦にある日付だけを本物に数える（うるう年も）", () => {
    expect(countRealEffectiveDates(withDate("2028年2月29日"))).toBe(1);
    expect(countRealEffectiveDates(withDate("2027年2月29日"))).toBe(0);
    expect(countRealEffectiveDates(withDate("2026年13月40日"))).toBe(0);
  });

  it("改定日：まだなければ通る。1つなら本物の日付を求め、2つ以上は止まる", () => {
    const dated = withDate("2026年12月1日");
    expect(countRevisionDateLines(dated)).toBe(0);
    expect(effectiveDateProblems([dated], { deploy: true, today: LATE })).toEqual([]);
    const revised = `${dated}${rev("2027年4月1日")}`;
    expect(countRevisionDateLines(revised)).toBe(1);
    expect(countRealRevisionDates(revised)).toBe(1);
    expect(effectiveDateProblems([revised], { deploy: true, today: day(2027, 4, 1) })).toEqual([]);
    expect(effectiveDateProblems([`${dated}${rev("2027年◯月◯日")}`], { deploy: false })).toEqual([]);
    expect(effectiveDateProblems([`${dated}${rev("2027年◯月◯日")}`], { deploy: true, today: LATE })).toHaveLength(1);
    expect(effectiveDateProblems([`${dated}${rev("2027年13月40日")}`], { deploy: true, today: LATE })).toHaveLength(1);
    expect(effectiveDateProblems([revised, rev("2027年5月1日")], { deploy: false })).toHaveLength(1);
  });

  it("前の形の「改定日：」は、いつもの検査でも止まる", () => {
    const dated = withDate("2026年12月1日");
    const old = `${dated}const V="改定日：2027年4月1日";`;
    expect(countOldRevisionDateLines(old)).toBe(1);
    expect(countRevisionDateLines(old)).toBe(0);
    expect(effectiveDateProblems([old], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([old], { deploy: true, today: LATE })).toHaveLength(1);
    // 新しい形と並んでいても、前の形の問題だけを出す（日付の大小は見ない）
    expect(effectiveDateProblems([`${old}${rev("2031年1月1日")}`], { deploy: true, today: LATE })).toHaveLength(1);
    // 新しい形と予告の行は、前の形に数えない（「改定日から」は「改定日：」ではない）
    expect(countOldRevisionDateLines(`${rev("2026年12月2日")}${notice("2026年11月25日")}`)).toBe(0);
  });
});

// 改定日（R）と公表日（P）の行。legal.ts の REVISION_DATE_LINE・REVISION_NOTICE_LINE の形
const rev = (date: string) => `const R="改定日（効力が生じる日）：${date}";`;
const notice = (date: string) => `const N="公表日：${date}（この版は改定日から適用します。それまでは、前の版を適用します）";`;
const day = (year: number, month: number, d: number): CalendarDay => ({ year, month, day: d });
const TODAY = day(2026, 11, 25);
/** 制定日などより十分あとの今日（大小の検査に当たらない日） */
const LATE = day(2030, 1, 1);
/** 制定日・改定日・公表日（なければ null）を入れた fixture */
const page = (r: string, p: string | null) => `${withDate("2026年11月23日")}${rev(r)}${p === null ? "" : notice(p)}`;

describe("公表日（予告の行）の検査", () => {
  it("数える：「公表日：」と本物の日付", () => {
    const text = page("2026年12月2日", "2026年11月25日");
    expect(countRevisionNoticeLines(text)).toBe(1);
    expect(countRealRevisionNoticeDates(text)).toBe(1);
    expect(countRealRevisionNoticeDates(page("2026年12月2日", "2026年◯月◯日"))).toBe(0);
    expect(countRealRevisionNoticeDates(page("2026年12月2日", "2026年11月31日"))).toBe(0);
  });

  it("いつもの検査：0回か1回。2回以上、または改定日の行がないのに公表日があれば止まる", () => {
    expect(effectiveDateProblems([page("2026年12月2日", "2026年11月25日")], { deploy: false })).toEqual([]);
    expect(effectiveDateProblems([page("2026年12月2日", null)], { deploy: false })).toEqual([]);
    expect(effectiveDateProblems([page("2026年12月2日", "2026年11月25日"), notice("2026年11月25日")], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([`${withDate("2026年11月23日")}${notice("2026年11月25日")}`], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([`${chunk}${notice("2026年11月25日")}`], { deploy: false })).toHaveLength(1);
  });

  it("いつもの検査は日付の大小を見ない（today を渡さなくても通る）", () => {
    for (const [r, p] of [
      ["2026年12月2日", "2026年11月25日"],
      ["2030年1月1日", "2029年1月1日"],
      ["2026年12月1日", "2026年11月30日"],
      ["2020年1月8日", "2020年1月1日"],
    ] as const) {
      expect(effectiveDateProblems([page(r, p)], { deploy: false })).toEqual([]);
    }
    expect(effectiveDateProblems([page("2030年1月1日", null)], { deploy: false })).toEqual([]);
  });

  it("--deploy：仮の値・暦にない公表日は止まる", () => {
    expect(effectiveDateProblems([page("2026年12月2日", "2026年◯月◯日")], { deploy: true, today: TODAY })).toHaveLength(1);
    expect(effectiveDateProblems([page("2026年12月2日", "2026年11月31日")], { deploy: true, today: TODAY })).toHaveLength(1);
  });

  it("--deploy：today がなければ止まる", () => {
    expect(effectiveDateProblems([page("2026年12月2日", "2026年11月25日")], { deploy: true })).toHaveLength(1);
  });
});

describe("--deploy の日付の大小（予告の間：P ≦ 今日 ≦ R、R − P は7日以上30日以下）", () => {
  // 本番にこの予告の行がもう出ている（2回め以降のデプロイ）。初めて出すデプロイは下の describe
  const check = (r: string, p: string | null, today: CalendarDay, noticeAlreadyPublished = true) =>
    effectiveDateProblems([page(r, p)], { deploy: true, today, noticeAlreadyPublished });

  it("公表日の日に、改定日をその7日後にしたデプロイは通る（今の legal.ts の形）", () => {
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 25), false)).toEqual([]);
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 25), true)).toEqual([]);
  });

  it("初めて予告を出すデプロイ（本番にまだ出ていない）は、公表日＝今日だけ通る", () => {
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 25), false)).toEqual([]);
    // 公表日より後に初めてデプロイした（予告が7日より短くなる）
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 26), false)).toHaveLength(1);
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 30), false)).toHaveLength(1);
    // 公表日より前
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 24), false)).toHaveLength(1);
  });

  it("本番に出ているかが分からなければ止まる", () => {
    expect(effectiveDateProblems([page("2026年12月2日", "2026年11月25日")], { deploy: true, today: TODAY })).toHaveLength(1);
  });

  it("R − P が7日・30日なら通り、6日・31日なら止まる", () => {
    expect(check("2026年12月2日", "2026年11月25日", TODAY)).toEqual([]);
    expect(check("2026年12月25日", "2026年11月25日", TODAY)).toEqual([]);
    expect(check("2026年12月1日", "2026年11月25日", TODAY)).toHaveLength(1);
    expect(check("2026年12月26日", "2026年11月25日", TODAY)).toHaveLength(1);
  });

  it("公表日が今日より後なら止まる", () => {
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 24))).toHaveLength(1);
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, 23))).toHaveLength(1);
  });

  it("予告の間のほかのデプロイ（P ＜ 今日 ≦ R）は通る", () => {
    for (const d of [26, 30]) expect(check("2026年12月2日", "2026年11月25日", day(2026, 11, d))).toEqual([]);
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 12, 1))).toEqual([]);
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 12, 2))).toEqual([]);
  });

  it("改定日を過ぎても予告の行が残っていれば止まる", () => {
    expect(check("2026年12月2日", "2026年11月25日", day(2026, 12, 3))).toHaveLength(1);
    expect(check("2026年12月2日", "2026年11月25日", day(2027, 1, 10))).toHaveLength(1);
  });

  it("月またぎ・年またぎ・うるう年の日数を正しく数える", () => {
    expect(daysBetween(day(2026, 11, 25), day(2026, 12, 2))).toBe(7);
    expect(daysBetween(day(2026, 12, 28), day(2027, 1, 4))).toBe(7);
    expect(daysBetween(day(2028, 2, 23), day(2028, 3, 1))).toBe(7);
    expect(daysBetween(day(2027, 2, 22), day(2027, 3, 1))).toBe(7);
    expect(daysBetween(day(2027, 2, 23), day(2027, 3, 1))).toBe(6);
    // 年またぎ：7日なら通り、6日なら止まる
    expect(check("2027年1月4日", "2026年12月28日", day(2026, 12, 31))).toEqual([]);
    expect(check("2027年1月3日", "2026年12月28日", day(2026, 12, 31))).toHaveLength(1);
    // うるう年：2028年2月は29日まであるので、2月23日から3月1日は7日。2027年は6日
    expect(check("2028年3月1日", "2028年2月23日", day(2028, 2, 23))).toEqual([]);
    expect(check("2027年3月1日", "2027年2月23日", day(2027, 2, 23))).toHaveLength(1);
    // 30日：1月31日から3月1日（うるう年は30日、平年は29日）
    expect(check("2028年3月2日", "2028年2月1日", day(2028, 2, 1))).toEqual([]);
    expect(check("2028年3月3日", "2028年2月1日", day(2028, 2, 1))).toHaveLength(1);
  });
});

describe("--deploy の制定日の大小（制定日 ≦ 今日、制定日 ≦ 公表日 ≦ 改定日、予告がなければ 制定日 ＜ 改定日）", () => {
  const effective = (e: string, r: string | null, p: string | null) =>
    `${withDate(e)}${r === null ? "" : rev(r)}${p === null ? "" : notice(p)}`;
  const problems = (text: string, today: CalendarDay) =>
    effectiveDateProblems([text], { deploy: true, today, noticeAlreadyPublished: true });

  it("制定日が今日より後なら止まる", () => {
    expect(problems(effective("2026年11月23日", null, null), day(2026, 11, 23))).toEqual([]);
    expect(problems(effective("2026年11月24日", null, null), day(2026, 11, 23))).toHaveLength(1);
  });

  it("公表日は制定日と同じ日か、より後（制定した日に予告できる。T-19 決めたこと16）", () => {
    expect(problems(effective("2026年11月24日", "2026年12月2日", "2026年11月25日"), TODAY)).toEqual([]);
    expect(problems(effective("2026年11月25日", "2026年12月2日", "2026年11月25日"), TODAY)).toEqual([]);
    expect(problems(effective("2026年11月26日", "2026年12月2日", "2026年11月25日"), TODAY)).toHaveLength(2);
  });

  it("予告がなければ、改定日は制定日より後", () => {
    expect(problems(effective("2026年11月23日", "2026年11月24日", null), TODAY)).toEqual([]);
    expect(problems(effective("2026年11月24日", "2026年11月24日", null), TODAY)).toHaveLength(1);
    expect(problems(effective("2026年11月25日", "2026年11月24日", null), TODAY)).toHaveLength(1);
  });
});

describe("--deploy の日付の大小（予告のあと：R ≦ 今日）", () => {
  const check = (r: string, today: CalendarDay) => effectiveDateProblems([page(r, null)], { deploy: true, today });

  it("改定日が今日か今日より前なら通る", () => {
    expect(check("2026年12月2日", day(2026, 12, 2))).toEqual([]);
    expect(check("2026年12月2日", day(2027, 3, 1))).toEqual([]);
  });

  it("改定日が今日より後なのに予告の行がなければ止まる", () => {
    expect(check("2026年12月2日", day(2026, 12, 1))).toHaveLength(1);
    expect(check("2027年1月1日", day(2026, 12, 31))).toHaveLength(1);
  });
});

describe("予告の行を取り出す", () => {
  it("dist の JS から「公表日：…（…）」の全体を返し、なければ null", () => {
    expect(revisionNoticeLine([chunk, page("2026年12月2日", "2026年11月25日")])).toBe(
      "公表日：2026年11月25日（この版は改定日から適用します。それまでは、前の版を適用します）",
    );
    expect(revisionNoticeLine([page("2026年12月2日", null)])).toBeNull();
  });
});

describe("日本時間の今日", () => {
  it("UTC の15時からは、日本時間の次の日", () => {
    expect(jstToday(Date.UTC(2026, 10, 24, 14, 59, 59))).toEqual(day(2026, 11, 24));
    expect(jstToday(Date.UTC(2026, 10, 24, 15, 0, 0))).toEqual(day(2026, 11, 25));
    expect(jstToday(Date.UTC(2026, 11, 31, 15, 0, 0))).toEqual(day(2027, 1, 1));
  });
});

// 問い合わせの公開の日（docs/specs/T-24-contact.md「振る舞い 11.」「テスト計画」）
describe("問い合わせの公開の日の検査", () => {
  const dated = withDate("2026年11月23日");
  const announced = `${dated}${rev("2026年12月2日")}${notice("2026年11月25日")}`;
  const BEFORE = day(2026, 11, 25);

  it("今日が公開の日より前：改定日の日付が公開の日と同じで、予告の行があれば通る", () => {
    expect(contactStartProblems([announced], { startDate: "2026-12-02", deploy: true, today: BEFORE })).toEqual([]);
  });

  it("今日が公開の日より前：改定日が違う・改定日がない・予告の行がないと止まる", () => {
    expect(contactStartProblems([announced], { startDate: "2026-12-03", deploy: true, today: BEFORE })).toHaveLength(1);
    expect(contactStartProblems([dated], { startDate: "2026-12-02", deploy: true, today: BEFORE })).toHaveLength(2);
    expect(contactStartProblems([`${dated}${rev("2026年12月2日")}`], { startDate: "2026-12-02", deploy: true, today: BEFORE })).toHaveLength(1);
  });

  it("今日が公開の日以後・null なら条件を見ない。いつもの検査（deploy でない）も日付の大小を見ない", () => {
    expect(contactStartProblems([dated], { startDate: "2026-12-02", deploy: true, today: day(2026, 12, 2) })).toEqual([]);
    expect(contactStartProblems([dated], { startDate: "2026-12-02", deploy: true, today: LATE })).toEqual([]);
    expect(contactStartProblems([dated], { startDate: null, deploy: true, today: BEFORE })).toEqual([]);
    expect(contactStartProblems([dated], { startDate: "2026-12-02", deploy: false })).toEqual([]);
  });

  it("暦にない日付・形の違う文字列は、いつもの検査でも止まる", () => {
    for (const startDate of ["2026-02-30", "2026-13-01", "2026/12/02", "2026-12-2", "", 20261202]) {
      expect(contactStartProblems([dated], { startDate, deploy: false }), String(startDate)).toHaveLength(1);
    }
  });

  it("今の contactStart.json の値は、いつもの検査を通る", () => {
    expect(contactStartProblems([announced], { startDate: contactStart.startDate, deploy: false })).toEqual([]);
  });
});
