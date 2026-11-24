import { DEFAULT_PRESETS, type MyAvailability } from "@kokohima/shared";
import { describe, expect, it } from "vitest";
import { cellName, cellOf, cellState, cellText, hasEnded, isPast, itemsByCell, restoreBody, weekDates, weekRangeText } from "./week";

// 週の帯の計算（docs/specs/T-55-availability-week-grid.md「振る舞い」）。東京（+09:00）

const item = (over: Partial<MyAvailability>): MyAvailability => ({
  source: "manual",
  id: "33333333-3333-4333-8333-333333333333",
  date: null,
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  label: "night",
  freeNow: false,
  ...over,
});
const TODAY = "2026-10-10";

describe("週の日付", () => {
  it("今日から7日、次の週はその続き。月をまたぐ", () => {
    expect(weekDates("2026-10-28", 0)).toEqual(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(weekDates("2026-10-28", 1)[0]).toBe("2026-11-04");
    expect(weekRangeText(weekDates("2026-10-28", 0))).toBe("10/28〜11/3");
  });
});

describe("どのマスに入るか", () => {
  it("プリセットの名前があれば、開始の日付のその時間帯", () => {
    expect(cellOf(item({}), DEFAULT_PRESETS, TODAY)).toEqual({ date: "2026-10-10", preset: "night" });
  });

  it("時刻を指定した枠は、重なりの一番長い時間帯。同じなら早い時間帯", () => {
    // 東京 14:00〜20:00：昼1時間・夕方3時間・夜1時間
    expect(cellOf(item({ label: null, startsAt: "2026-10-10T05:00:00Z", endsAt: "2026-10-10T11:00:00Z" }), DEFAULT_PRESETS, TODAY).preset).toBe("evening");
    // 東京 17:00〜21:00：夕方2時間・夜2時間 → 夕方
    expect(cellOf(item({ label: null, startsAt: "2026-10-10T08:00:00Z", endsAt: "2026-10-10T12:00:00Z" }), DEFAULT_PRESETS, TODAY).preset).toBe("evening");
  });

  it("どの時間帯とも重ならなければ、一番近い時間帯", () => {
    // 東京 6:00〜8:00 → 昼（11:00 まで3時間）
    expect(cellOf(item({ label: null, startsAt: "2026-10-10T21:00:00Z", endsAt: "2026-10-10T23:00:00Z" }), DEFAULT_PRESETS, TODAY)).toEqual({
      date: "2026-10-11",
      preset: "day",
    });
    // 東京 23:30〜翌2:00 → 夜
    expect(cellOf(item({ label: null, startsAt: "2026-10-10T14:30:00Z", endsAt: "2026-10-10T17:00:00Z" }), DEFAULT_PRESETS, TODAY)).toEqual({
      date: "2026-10-10",
      preset: "night",
    });
  });

  it("今日より前に始まった枠（今から暇）は今日のマス", () => {
    // 東京 前日22:00〜今日12:00
    expect(cellOf(item({ label: null, startsAt: "2026-10-09T13:00:00Z", endsAt: "2026-10-10T03:00:00Z" }), DEFAULT_PRESETS, TODAY)).toEqual({
      date: "2026-10-10",
      preset: "day",
    });
  });

  it("プリセットの境界を変えていれば、変えたあとの時刻で決める", () => {
    const presets = { ...DEFAULT_PRESETS, night: { start: "20:00", end: "24:00" } };
    // 東京 19:00〜20:30：夕方0分（16-19）・夜30分
    expect(cellOf(item({ label: null, startsAt: "2026-10-10T10:00:00Z", endsAt: "2026-10-10T11:30:00Z" }), presets, TODAY).preset).toBe("night");
  });

  it("同じマスの枠はまとめる", () => {
    const cells = itemsByCell([item({}), item({ source: "recurrence", date: "2026-10-10", label: null, startsAt: "2026-10-10T11:00:00Z", endsAt: "2026-10-10T13:00:00Z" })], DEFAULT_PRESETS, TODAY);
    expect(cells.get("2026-10-10|night")).toHaveLength(2);
  });
});

describe("過ぎた時間帯", () => {
  it("終わりが今以前なら過ぎた。始まっていても終わっていなければ押せる", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(isPast(DEFAULT_PRESETS, { date: TODAY, preset: "day" }, at("2026-10-10T06:00:00Z"))).toBe(true);
    expect(isPast(DEFAULT_PRESETS, { date: TODAY, preset: "day" }, at("2026-10-10T05:59:00Z"))).toBe(false);
    expect(isPast(DEFAULT_PRESETS, { date: TODAY, preset: "evening" }, at("2026-10-10T07:30:00Z"))).toBe(false);
  });

  it("24:00 の終わりは翌日の 0:00", () => {
    const presets = { ...DEFAULT_PRESETS, night: { start: "20:00", end: "24:00" } };
    expect(isPast(presets, { date: TODAY, preset: "night" }, Date.parse("2026-10-10T14:59:00Z"))).toBe(false);
    expect(isPast(presets, { date: TODAY, preset: "night" }, Date.parse("2026-10-10T15:00:00Z"))).toBe(true);
  });

  it("枠の終わりが今以前なら終わった（作り直せない）", () => {
    const ended = item({ endsAt: "2026-10-10T14:00:00.000Z" });
    expect(hasEnded(ended, Date.parse("2026-10-10T14:00:00Z"))).toBe(true);
    expect(hasEnded(ended, Date.parse("2026-10-10T13:59:00Z"))).toBe(false);
  });
});

describe("マスの名前と中身", () => {
  const night = { date: TODAY, preset: "night" as const };
  it("空・カレンダーで空き・過ぎた", () => {
    expect(cellName(night, cellState(undefined, false, false))).toBe("10/10（土） 夜 19:00〜23:00。押すとここ暇にする");
    expect(cellName(night, cellState([], true, false))).toBe("10/10（土） 夜 19:00〜23:00 カレンダーで空き。押すとここ暇にする");
    expect(cellName(night, cellState(undefined, true, true))).toBe("10/10（土） 夜 過ぎた時間帯");
  });

  it("ここ暇・くり返し・2つ以上。過ぎた時間帯でも、ここ暇があれば押せる", () => {
    expect(cellName(night, cellState([item({})], false, true))).toBe("10/10（土） 夜 ここ暇 19:00〜23:00。押すと取り消す");
    expect(cellName(night, cellState([item({ source: "recurrence", date: TODAY })], false, false))).toBe(
      "10/10（土） 夜 くり返しのここ暇 19:00〜23:00。押すとこの日だけ外す",
    );
    expect(cellName(night, cellState([item({}), item({ id: "x" })], false, false))).toBe("10/10（土） 夜 ここ暇が2つ。押すと選べる");
  });

  it("中身：時間帯に合う枠は「暇」、時刻を指定した枠は開始の時刻、2つ以上は数", () => {
    expect(cellText(night, cellState([item({})], false, false))).toBe("暇");
    expect(cellText(night, cellState([item({ label: null, startsAt: "2026-10-10T11:30:00Z" })], false, false))).toBe("20:30");
    expect(cellText(night, cellState([item({}), item({ id: "x" })], false, false))).toBe("2つ");
    expect(cellText(night, cellState(undefined, true, false))).toBe("");
  });
});

describe("取り消したここ暇を戻す本文", () => {
  it("プリセットの時刻のままなら日付とプリセット（名前を残す）", () => {
    expect(restoreBody(item({}), DEFAULT_PRESETS)).toEqual({ date: "2026-10-10", preset: "night" });
  });
  it("時刻を指定した枠や、プリセットを変えたあとは開始・終了", () => {
    expect(restoreBody(item({ label: null }), DEFAULT_PRESETS)).toEqual({ startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z" });
    const presets = { ...DEFAULT_PRESETS, night: { start: "20:00", end: "23:00" } };
    expect(restoreBody(item({}), presets)).toEqual({ startsAt: "2026-10-10T10:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z" });
  });
});
