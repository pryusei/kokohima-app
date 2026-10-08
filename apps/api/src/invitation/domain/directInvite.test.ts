import { describe, expect, it } from "vitest";
import {
  cancelError,
  checkInviteTime,
  DAY_MS,
  decideError,
  effectiveStatus,
  expiresAtFor,
  HOUR_MS,
  isSameRange,
  kindFor,
  MINUTE_MS,
  respondError,
  retryAfterSeconds,
  type InviteTimes,
  type StoredStatus,
} from "./directInvite";

const now = Date.parse("2026-10-10T00:00:00Z");
const at = (iso: string) => Date.parse(iso);

describe("時間の検証", () => {
  it("開始は現在より後、60日以内、15分単位、30分以上24時間以下", () => {
    expect(checkInviteTime(now + HOUR_MS, now + 2 * HOUR_MS, now)).toBeNull();
    expect(checkInviteTime(now + 10 * MINUTE_MS, now + HOUR_MS, now)).toBe("not_quarter");
    expect(checkInviteTime(now + HOUR_MS, now + HOUR_MS + 15 * MINUTE_MS, now)).toBe("too_short");
    expect(checkInviteTime(now + HOUR_MS, now + HOUR_MS + DAY_MS + 15 * MINUTE_MS, now)).toBe("too_long");
    expect(checkInviteTime(now, now + HOUR_MS, now)).toBe("in_past");
    expect(checkInviteTime(now + 60 * DAY_MS, now + 60 * DAY_MS + HOUR_MS, now)).toBeNull();
    expect(checkInviteTime(now + 60 * DAY_MS + 15 * MINUTE_MS, now + 61 * DAY_MS, now)).toBe("too_far");
  });
});

describe("返事の期限", () => {
  it("選んだ時間と開始日時の早いほう", () => {
    const start = now + 2 * HOUR_MS;
    expect(expiresAtFor("1h", start, now)).toBe(now + HOUR_MS);
    expect(expiresAtFor("3h", start, now)).toBe(start);
    expect(expiresAtFor("24h", start, now)).toBe(start);
    expect(expiresAtFor("until_start", start, now)).toBe(start);
    expect(expiresAtFor("24h", now + 2 * DAY_MS, now)).toBe(now + DAY_MS);
  });
});

describe("あそぼ／ここどう？", () => {
  const invite = { startsAt: at("2026-10-10T10:00:00Z"), endsAt: at("2026-10-10T12:00:00Z") };
  it("見えている枠と1分以上重なれば asobo、接するだけ・なしは kokodou", () => {
    expect(kindFor([{ startsAt: at("2026-10-10T11:59:00Z"), endsAt: at("2026-10-10T13:00:00Z") }], invite)).toBe("asobo");
    expect(kindFor([{ startsAt: at("2026-10-10T12:00:00Z"), endsAt: at("2026-10-10T13:00:00Z") }], invite)).toBe("kokodou");
    expect(kindFor([], invite)).toBe("kokodou");
  });
});

describe("状態", () => {
  const invite = (status: StoredStatus, over: Partial<InviteTimes> = {}): InviteTimes => ({
    status,
    expiresAt: now + HOUR_MS,
    counterStartsAt: null,
    ...over,
  });

  it("期限切れは読むときに決める（返事待ちは期限、この時間ならは代わりの時間の開始）", () => {
    expect(effectiveStatus(invite("pending"), now)).toBe("pending");
    expect(effectiveStatus(invite("pending", { expiresAt: now }), now)).toBe("expired");
    expect(effectiveStatus(invite("counter_proposed", { expiresAt: now - 1, counterStartsAt: now + 1 }), now)).toBe(
      "counter_proposed",
    );
    expect(effectiveStatus(invite("counter_proposed", { counterStartsAt: now }), now)).toBe("expired");
    for (const s of ["confirmed", "declined", "skipped", "cancelled"] as const) {
      expect(effectiveStatus(invite(s, { expiresAt: now - 1 }), now)).toBe(s);
    }
  });

  it("返答は pending だけ。状態が違えば invalid_state を先に、期限切れは expired", () => {
    expect(respondError(invite("pending"), now)).toBeNull();
    expect(respondError(invite("pending", { expiresAt: now }), now)).toBe("expired");
    for (const s of ["counter_proposed", "confirmed", "declined", "skipped", "cancelled"] as const) {
      expect(respondError(invite(s, { expiresAt: now - 1 }), now)).toBe("invalid_state");
    }
  });

  it("決定は counter_proposed だけ。代わりの時間の開始後は expired", () => {
    expect(decideError(invite("counter_proposed", { counterStartsAt: now + 1 }), now)).toBeNull();
    expect(decideError(invite("counter_proposed", { counterStartsAt: now }), now)).toBe("expired");
    for (const s of ["pending", "confirmed", "declined", "skipped", "cancelled"] as const) {
      expect(decideError(invite(s, { counterStartsAt: now - 1 }), now)).toBe("invalid_state");
    }
  });

  it("やっぱり難しいは confirmed で開始前だけ", () => {
    expect(cancelError({ status: "confirmed", startsAt: now + 1 }, now)).toBeNull();
    expect(cancelError({ status: "confirmed", startsAt: now }, now)).toBe("expired");
    expect(cancelError({ status: "cancelled", startsAt: now - 1 }, now)).toBe("invalid_state");
  });
});

describe("その他", () => {
  it("同じ時間の判定と Retry-After", () => {
    expect(isSameRange({ startsAt: 1, endsAt: 2 }, { startsAt: 1, endsAt: 2 })).toBe(true);
    expect(isSameRange({ startsAt: 1, endsAt: 2 }, { startsAt: 1, endsAt: 3 })).toBe(false);
    expect(retryAfterSeconds(now - DAY_MS + 90_500, now)).toBe(91);
    expect(retryAfterSeconds(now - DAY_MS, now)).toBe(1);
  });
});
