import { describe, expect, it } from "vitest";
import { decideError, leaveError, ownerResponseCount, respondError, viewerStatus, type BroadcastView } from "./broadcast";

const now = Date.parse("2026-10-10T00:00:00Z");
const before = now + 1;
const after = now;

describe("閲覧者ごとの状態", () => {
  const view = (over: Partial<BroadcastView>): BroadcastView => ({
    stored: "open",
    expiresAt: before,
    isOwner: false,
    isParticipant: false,
    ...over,
  });

  it.each([
    // 保存, 期限前か, 募集者, 参加者, 参加者でない宛先
    ["open", true, "open", null, "open"],
    ["open", false, "expired", null, "closed"],
    ["decided", true, "decided", "decided", "open"],
    ["decided", false, "decided", "decided", "closed"],
  ] as const)("保存 %s・期限前 %s", (stored, inTime, owner, participant, other) => {
    const expiresAt = inTime ? before : after;
    expect(viewerStatus(view({ stored, expiresAt, isOwner: true }), now)).toBe(owner);
    if (participant) expect(viewerStatus(view({ stored, expiresAt, isParticipant: true }), now)).toBe(participant);
    expect(viewerStatus(view({ stored, expiresAt }), now)).toBe(other);
  });

  it("参加者でない宛先の人には、決まった募集と期限切れの募集が同じに見える", () => {
    for (const expiresAt of [before, after]) {
      expect(viewerStatus(view({ stored: "decided", expiresAt }), now)).toBe(
        viewerStatus(view({ stored: "open", expiresAt }), now),
      );
    }
  });
});

describe("条件", () => {
  it("募集者の人数：決める前は今応じている人数、決めた後は予定に入った人数（募集者を除く）", () => {
    expect(ownerResponseCount("open", 2, 0)).toBe(2);
    expect(ownerResponseCount("decided", 5, 3)).toBe(2);
  });

  it("応じる・やめる：参加者は invalid_state、それ以外は期限後に expired", () => {
    expect(respondError({ isParticipant: true, expiresAt: before }, now)).toBe("invalid_state");
    expect(respondError({ isParticipant: false, expiresAt: after }, now)).toBe("expired");
    expect(respondError({ isParticipant: false, expiresAt: before }, now)).toBeNull();
  });

  it("決める：状態 → 期限 → 応じた人の順", () => {
    expect(decideError({ stored: "decided", expiresAt: after, responding: 0 }, now)).toBe("invalid_state");
    expect(decideError({ stored: "open", expiresAt: after, responding: 0 }, now)).toBe("expired");
    expect(decideError({ stored: "open", expiresAt: before, responding: 0 }, now)).toBe("invalid_state");
    expect(decideError({ stored: "open", expiresAt: before, responding: 1 }, now)).toBeNull();
  });

  it("抜ける：抜けた後・取り消し済みは invalid_state、開始後は expired", () => {
    expect(leaveError({ left: true, status: "confirmed", startsAt: before }, now)).toBe("invalid_state");
    expect(leaveError({ left: false, status: "cancelled", startsAt: after }, now)).toBe("invalid_state");
    expect(leaveError({ left: false, status: "confirmed", startsAt: after }, now)).toBe("expired");
    expect(leaveError({ left: false, status: "confirmed", startsAt: before }, now)).toBeNull();
  });
});
