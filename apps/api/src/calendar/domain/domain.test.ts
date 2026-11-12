import { describe, expect, it } from "vitest";
import { clip, decodeBusy, encodeBusy, newlyBusy, normalize, overlapsAny, subtract } from "./busy";
import { buildIcs, escapeText, foldLine, icsDate } from "./ics";
import { externalEventId } from "./provider";

const M = 60 * 1000;
const H = 60 * M;
const i = (s: number, e: number) => ({ startsAt: s * H, endsAt: e * H });

describe("埋まりの区間", () => {
  it("normalize：並べ替え、重なる・接する区間をつなぎ、長さのない区間を捨てる", () => {
    expect(normalize([i(5, 6), i(1, 3), i(2, 4), i(4, 4.5), i(7, 7)])).toEqual([i(1, 4.5), i(5, 6)]);
  });

  it("subtract：前回の埋まりを引く（広がった・分かれた・消えた）", () => {
    expect(subtract([i(1, 5)], [i(2, 3)])).toEqual([i(1, 2), i(3, 5)]);
    expect(subtract([i(1, 3)], [i(1, 3)])).toEqual([]);
    expect(subtract([i(1, 4)], [i(1, 3)])).toEqual([i(3, 4)]);
    expect(subtract([], [i(1, 3)])).toEqual([]);
  });

  it("clip：範囲の中だけ", () => {
    expect(clip([i(0, 2), i(5, 9)], 1 * H, 6 * H)).toEqual([i(1, 2), i(5, 6)]);
  });

  it("newlyBusy：前回にない埋まりのうち、前回の範囲に入る部分だけ", () => {
    const previous = { busy: [i(10, 11)], from: 0, to: 20 * H };
    expect(newlyBusy(previous, [i(10, 11)])).toEqual([]);
    expect(newlyBusy(previous, [i(10, 11), i(12, 13)])).toEqual([i(12, 13)]);
    // 前回の範囲の外（範囲がずれて新しく見えるようになった先）は新しく入ったものとしない
    expect(newlyBusy(previous, [i(19, 22)])).toEqual([i(19, 20)]);
    expect(newlyBusy(previous, [i(21, 22)])).toEqual([]);
    // 消えた埋まりは新しくない
    expect(newlyBusy(previous, [])).toEqual([]);
    // 埋まりが広がった・つながった
    expect(newlyBusy(previous, [i(9, 12)])).toEqual([i(9, 10), i(11, 12)]);
  });

  it("overlapsAny：1分以上の重なりだけ（接するだけ・59秒は重ならない）", () => {
    const slot = i(10, 12);
    expect(overlapsAny(slot, [i(12, 13)])).toBe(false);
    expect(overlapsAny(slot, [{ startsAt: 12 * H - M, endsAt: 13 * H }])).toBe(true);
    expect(overlapsAny(slot, [{ startsAt: 12 * H - 59_000, endsAt: 13 * H }])).toBe(false);
  });

  it("保存の形は時刻の配列だけで、往復できる", () => {
    const encoded = encodeBusy([i(3, 4), i(1, 2)]);
    expect(encoded).toBe(JSON.stringify([[1 * H, 2 * H], [3 * H, 4 * H]]));
    expect(decodeBusy(encoded)).toEqual([i(1, 2), i(3, 4)]);
    expect(decodeBusy('[[1,"x"],{"a":1},[5,9]]')).toEqual([{ startsAt: 5, endsAt: 9 }]);
  });
});

describe(".ics", () => {
  it("TEXT のエスケープ（\\ ; , 改行）と制御文字の除去", () => {
    expect(escapeText("a\\b;c,d\r\ne\nf\u0007")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
  });

  it("75オクテットで折り返し、UTF-8 の文字の途中で切らない", () => {
    const line = `SUMMARY:${"あ".repeat(40)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) expect(new TextEncoder().encode(part).byteLength).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((p, n) => (n === 0 ? p : p.slice(1))).join("")).toBe(line);
  });

  it("利用者の文字列で別のプロパティや VEVENT を作れない", () => {
    const ics = buildIcs({
      uid: "m1@kokohima",
      stamp: Date.parse("2026-10-10T00:00:00Z"),
      startsAt: Date.parse("2026-10-10T11:00:00Z"),
      endsAt: Date.parse("2026-10-10T13:00:00Z"),
      summary: "ここ暇：あき",
      location: "渋谷\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:x;y,z",
      description: "https://app.test/meetups/m1",
      status: "CONFIRMED",
      sequence: 0,
    });
    expect(ics.match(/^BEGIN:VEVENT/gm)).toHaveLength(1);
    expect(ics.match(/^SUMMARY:/gm)).toHaveLength(1);
    expect(ics).toContain("LOCATION:渋谷\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:x\\;y\\,z");
    expect(ics).toContain("DTSTART:20261010T110000Z");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("キャンセル済みは STATUS:CANCELLED と METHOD:CANCEL、SEQUENCE:1", () => {
    const ics = buildIcs({
      uid: "m1@kokohima",
      stamp: 0,
      startsAt: 0,
      endsAt: H,
      summary: "s",
      location: "",
      description: "d",
      status: "CANCELLED",
      sequence: 1,
    });
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("SEQUENCE:1");
    expect(ics).not.toContain("LOCATION:");
  });

  it("icsDate は UTC の基本形式", () => {
    expect(icsDate(Date.parse("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

describe("予定のID", () => {
  it("base32hex（0-9a-v）の5〜1024文字に収まる", () => {
    const id = externalEventId("0F8FAD5B-D9CB-469F-A165-70867728950E");
    expect(id).toBe("kh0f8fad5bd9cb469fa16570867728950e");
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});
