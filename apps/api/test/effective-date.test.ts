import { describe, expect, it } from "vitest";
import {
  countEffectiveDateLines,
  countRealEffectiveDates,
  effectiveDateProblems,
  EXPECTED_EFFECTIVE_DATE_LINES,
} from "../scripts/lib/effective-date.mjs";
import chunk from "./fixtures/web-dist-legal.js?raw";

// 制定日の行の検査（docs/specs/T-19-privacy-terms.md「5.」）。fixture は vite が圧縮した chunk をまねたもの
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
    expect(effectiveDateProblems([chunk], { deploy: true })).toHaveLength(1);
  });

  it("本物の日付：どちらも通る", () => {
    for (const date of ["2026年12月1日", "2027年1月15日"]) {
      const text = withDate(date);
      expect(countRealEffectiveDates(text)).toBe(1);
      expect(effectiveDateProblems([text], { deploy: true })).toEqual([]);
    }
  });

  it("形の違う日付は本物に数えない", () => {
    for (const date of ["2026年12月", "2026/12/1", "26年12月1日", "2026年◯月1日"]) {
      expect(countRealEffectiveDates(withDate(date))).toBe(0);
      expect(effectiveDateProblems([withDate(date)], { deploy: true })).toHaveLength(1);
    }
  });

  it("「制定日：」が0回・2回なら、いつもの検査でも止まる", () => {
    expect(effectiveDateProblems([chunk.replace(PLACEHOLDER, "2026年12月1日")], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([chunk, withDate("2026年12月1日")], { deploy: false })).toHaveLength(1);
    expect(effectiveDateProblems([`${chunk}"制定日："+d`], { deploy: false })).toHaveLength(1);
  });
});
