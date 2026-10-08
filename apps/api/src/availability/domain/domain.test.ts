import { describe, expect, it } from "vitest";
import { expandRule, type RecurrenceRule } from "./recurrence";
import { buildFriendSlots, inRange, mergeSlots, overlaps, pageAfter, type Slot } from "./slots";
import { checkLocalRange, checkManualSlot } from "./validation";
import { addDays, DAY_MS, localDateOf, localToUtc, parseHhmm, weekdayOf } from "./zonedTime";

const iso = (ms: number) => new Date(ms).toISOString();
const at = (s: string) => Date.parse(s);

describe("localToUtc", () => {
  it("Asia/Tokyo（夏時間なし）", () => {
    expect(iso(localToUtc("2026-10-10", 19 * 60, "Asia/Tokyo"))).toBe("2026-10-10T10:00:00.000Z");
    expect(iso(localToUtc("2026-10-10", 1440, "Asia/Tokyo"))).toBe("2026-10-10T15:00:00.000Z");
  });

  it("America/New_York：夏時間の始まり（2026-03-08 2:30 は存在しないので 3:30 にずらす）", () => {
    expect(iso(localToUtc("2026-03-08", 150, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(localToUtc("2026-03-08", 60, "America/New_York"))).toBe("2026-03-08T06:00:00.000Z");
    expect(iso(localToUtc("2026-03-08", 4 * 60, "America/New_York"))).toBe("2026-03-08T08:00:00.000Z");
  });

  it("America/New_York：夏時間の終わり（2026-11-01 1:30 は二重なので早いほう）", () => {
    expect(iso(localToUtc("2026-11-01", 90, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(localToUtc("2026-11-01", 3 * 60, "America/New_York"))).toBe("2026-11-01T08:00:00.000Z");
  });
});

describe("日付", () => {
  it("現地の日付・曜日・日数の加算", () => {
    expect(localDateOf(at("2026-10-10T15:30:00Z"), "Asia/Tokyo")).toBe("2026-10-11");
    expect(weekdayOf("2026-10-10")).toBe(6);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("HH:MM", () => {
    expect(parseHhmm("24:00")).toBe(1440);
    expect(parseHhmm("24:15")).toBeNull();
    expect(parseHhmm("12:60")).toBeNull();
    expect(parseHhmm("1:00")).toBeNull();
  });
});

describe("expandRule", () => {
  const rule = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
    id: "r1",
    weekday: 6, // 土曜
    startMinute: 11 * 60,
    endMinute: 15 * 60,
    label: "day",
    timezone: "Asia/Tokyo",
    exceptions: new Set(),
    ...over,
  });
  const now = at("2026-10-05T00:00:00Z");

  it("範囲内の曜日に展開し、例外の日を除く", () => {
    const from = at("2026-10-05T00:00:00Z");
    const to = from + 14 * DAY_MS;
    expect(expandRule(rule(), from, to, now).map((s) => s.date)).toEqual(["2026-10-10", "2026-10-17"]);
    expect(expandRule(rule({ exceptions: new Set(["2026-10-10"]) }), from, to, now).map((s) => s.date)).toEqual([
      "2026-10-17",
    ]);
  });

  it("範囲の端と重なる枠は入り、重ならない枠は入らない。過去の枠は出さない", () => {
    const sat = rule();
    // 2026-10-10 11:00〜15:00 JST = 02:00〜06:00Z
    expect(expandRule(sat, at("2026-10-10T05:00:00Z"), at("2026-10-10T07:00:00Z"), now)).toHaveLength(1);
    expect(expandRule(sat, at("2026-10-10T06:00:00Z"), at("2026-10-10T07:00:00Z"), now)).toHaveLength(0);
    expect(expandRule(sat, at("2026-10-10T00:00:00Z"), at("2026-10-11T00:00:00Z"), at("2026-10-10T06:00:00Z"))).toHaveLength(0);
  });

  it("夏時間の切り替え日にも規則どおり（New York の日曜 1:00〜3:00）", () => {
    const sun = rule({ weekday: 0, startMinute: 60, endMinute: 180, timezone: "America/New_York" });
    const [slot] = expandRule(sun, at("2026-11-01T00:00:00Z"), at("2026-11-02T00:00:00Z"), at("2026-10-01T00:00:00Z"));
    expect(iso(slot?.startsAt ?? 0)).toBe("2026-11-01T05:00:00.000Z");
    expect(iso(slot?.endsAt ?? 0)).toBe("2026-11-01T08:00:00.000Z");
  });

  it("変換後に終了が開始以前になる枠は作らない（New York の 2026-03-08 2:30〜3:00）", () => {
    // 開始 2:30 は存在しないので 3:30 EDT（07:30Z）にずれ、終了 3:00 EDT は 07:00Z。終了が開始より前になる
    const gap = rule({ weekday: 0, startMinute: 150, endMinute: 180, timezone: "America/New_York" });
    const range = [at("2026-03-08T00:00:00Z"), at("2026-03-09T00:00:00Z"), at("2026-03-01T00:00:00Z")] as const;
    expect(expandRule(gap, ...range)).toEqual([]);
    // 2:00〜2:30 は 3:00〜3:30 にずれ、終了が開始より後なので作られる
    const shifted = expandRule(rule({ weekday: 0, startMinute: 120, endMinute: 150, timezone: "America/New_York" }), ...range);
    expect(shifted.map((x) => [iso(x.startsAt), iso(x.endsAt)])).toEqual([["2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z"]]);
  });
});

describe("slots", () => {
  const s = (start: string, end: string, label: Slot["label"] = null): Slot => ({
    startsAt: at(start),
    endsAt: at(end),
    label,
  });

  it("重なりは1分以上", () => {
    const a = s("2026-10-10T10:00:00Z", "2026-10-10T12:00:00Z");
    expect(overlaps(a, s("2026-10-10T11:59:00Z", "2026-10-10T13:00:00Z"))).toBe(true);
    expect(overlaps(a, s("2026-10-10T12:00:00Z", "2026-10-10T13:00:00Z"))).toBe(false);
    expect(inRange(a, at("2026-10-10T11:00:00Z"), at("2026-10-10T20:00:00Z"))).toBe(true);
  });

  it("重なる・接する枠をまとめ、label は同じならその値、違えば null", () => {
    const merged = mergeSlots([
      s("2026-10-10T10:00:00Z", "2026-10-10T12:00:00Z", "night"),
      s("2026-10-10T12:00:00Z", "2026-10-10T13:00:00Z", "night"),
      s("2026-10-10T15:00:00Z", "2026-10-10T16:00:00Z", "day"),
      s("2026-10-10T15:30:00Z", "2026-10-10T17:00:00Z", "evening"),
    ]);
    expect(merged).toEqual([
      s("2026-10-10T10:00:00Z", "2026-10-10T13:00:00Z", "night"),
      s("2026-10-10T15:00:00Z", "2026-10-10T17:00:00Z", null),
    ]);
  });

  it("友達ごとにまとめ、重なりの印を付け、開始→友達IDの順に並べ、カーソルの後ろを切り出す", () => {
    const byFriend = new Map<string, Slot[]>([
      ["b", [s("2026-10-10T10:00:00Z", "2026-10-10T12:00:00Z")]],
      ["a", [s("2026-10-10T10:00:00Z", "2026-10-10T11:00:00Z"), s("2026-10-11T10:00:00Z", "2026-10-11T11:00:00Z")]],
    ]);
    const mine = [s("2026-10-10T11:30:00Z", "2026-10-10T13:00:00Z")];
    const sorted = buildFriendSlots(byFriend, mine);
    expect(sorted.map((x) => [x.friendId, x.overlapsMine])).toEqual([
      ["a", false],
      ["b", true],
      ["a", false],
    ]);
    const p1 = pageAfter(sorted, null, 2);
    expect(p1.items).toHaveLength(2);
    const p2 = pageAfter(sorted, p1.next, 2);
    expect(p2.items.map((x) => x.friendId)).toEqual(["a"]);
    expect(p2.next).toBeNull();
  });
});

describe("validation", () => {
  const now = at("2026-10-10T00:00:00Z");
  it("手動の枠", () => {
    expect(checkManualSlot(at("2026-10-10T10:00:00Z"), at("2026-10-10T11:00:00Z"), now)).toBeNull();
    expect(checkManualSlot(at("2026-10-10T10:10:00Z"), at("2026-10-10T11:00:00Z"), now)).toBe("not_quarter");
    expect(checkManualSlot(at("2026-10-10T10:00:00Z"), at("2026-10-10T10:15:00Z"), now)).toBe("too_short");
    expect(checkManualSlot(at("2026-10-10T10:00:00Z"), at("2026-10-11T10:15:00Z"), now)).toBe("too_long");
    expect(checkManualSlot(at("2026-10-09T10:00:00Z"), at("2026-10-09T11:00:00Z"), now)).toBe("in_past");
    expect(checkManualSlot(now + 61 * DAY_MS, now + 61 * DAY_MS + DAY_MS / 24, now)).toBe("too_far");
    // 開始は過去でもよい（今から暇）
    expect(checkManualSlot(at("2026-10-09T23:00:00Z"), at("2026-10-10T01:00:00Z"), now)).toBeNull();
  });

  it("現地の範囲（日をまたがない、15分単位、30分以上）", () => {
    expect(checkLocalRange(19 * 60, 23 * 60)).toBe(true);
    expect(checkLocalRange(23 * 60, 1440)).toBe(true);
    expect(checkLocalRange(23 * 60 + 45, 1440)).toBe(false);
    expect(checkLocalRange(10, 120)).toBe(false);
    expect(checkLocalRange(600, 615)).toBe(false);
  });
});
