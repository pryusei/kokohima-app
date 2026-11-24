import { describe, expect, it } from "vitest";
import { isQuietHours, SILENT_KINDS, type NotificationKind } from "./kinds";
import { formatStart, pushBodyFor, pushPayloadOf } from "./push-message";

// プッシュの本文と夜の時間（docs/specs/T-35-notification-visibility.md）

const START = Date.parse("2026-11-28T10:00:00Z"); // 東京で 11月28日(土) 19:00
const named: { displayName: string | null; withdrawn: boolean } = { displayName: "ゆい", withdrawn: false };
const body = (kind: NotificationKind, mode: "hidden" | "detailed", extra: { actor?: typeof named | null; startsAt?: number | null; count?: number } = {}) =>
  pushBodyFor({ kind, count: extra.count ?? null, actor: extra.actor ?? null, startsAt: extra.startsAt ?? null }, mode, "Asia/Tokyo");

describe("プッシュの本文", () => {
  it("出さない：種類だけ。名前と日時を渡されても入れない", () => {
    const expected: Partial<Record<NotificationKind, string>> = {
      invite_received: "誘いが届きました",
      invite_countered: "別の時間の提案があります",
      broadcast_received: "募集が届きました",
      broadcast_decided: "募集が決まりました！",
      meetup_confirmed: "予定が成立しました！",
      friend_added: "友達が増えました",
      calendar_reauth: "カレンダーの連携が切れました",
    };
    for (const [kind, text] of Object.entries(expected)) {
      expect(body(kind as NotificationKind, "hidden", { actor: named, startsAt: START })).toBe(text);
    }
    expect(body("availability_cancelled", "hidden", { count: 2 })).toBe("カレンダーの予定と重なったここ暇を2件取り消しました");
  });

  it("出す：相手の名前と開始の日時。退会した人・名前のない人・読めない相手", () => {
    expect(body("invite_received", "detailed", { actor: named, startsAt: START })).toBe("ゆいさんから誘いが届きました\n11月28日(土) 19:00〜");
    expect(body("broadcast_received", "detailed", { actor: named, startsAt: START })).toBe("ゆいさんが募集しています\n11月28日(土) 19:00〜");
    expect(body("meetup_confirmed", "detailed", { actor: { displayName: null, withdrawn: false } })).toBe("名前未設定の友達さんと予定が成立しました！");
    expect(body("broadcast_decided", "detailed", { actor: { displayName: null, withdrawn: true }, startsAt: START })).toBe(
      "退会したユーザーの募集が決まりました！\n11月28日(土) 19:00〜",
    );
    expect(body("friend_added", "detailed", { actor: null })).toBe("友達が増えました");
    expect(body("calendar_reauth", "detailed", { actor: named })).toBe("カレンダーの連携が切れました");
  });

  it("鳴らさない種類と新端末のログインは、プッシュの文を持たない", () => {
    for (const kind of [...SILENT_KINDS, "new_login" as const]) {
      expect(body(kind, "hidden")).toBeNull();
      expect(body(kind, "detailed", { actor: named, startsAt: START })).toBeNull();
    }
    expect([...SILENT_KINDS].sort()).toEqual(["invite_declined", "invite_skipped", "meetup_cancelled", "meetup_left"]);
  });

  it("日時は受け取り手のタイムゾーンで、0時台も2桁", () => {
    expect(formatStart(Date.parse("2026-11-28T15:05:00Z"), "Asia/Tokyo")).toBe("11月29日(日) 00:05〜");
    expect(formatStart(START, "America/Los_Angeles")).toBe("11月28日(土) 02:00〜");
  });

  it("Service Worker に渡す中身は v・id・body だけ", () => {
    expect(JSON.parse(pushPayloadOf("n-1", "誘いが届きました"))).toEqual({ v: 1, id: "n-1", body: "誘いが届きました" });
  });
});

describe("夜の時間（日本時間の22時〜7時）", () => {
  it("境目：21:59 は鳴らす、22:00〜6:59 は鳴らさない、7:00 からは鳴らす", () => {
    const at = (iso: string) => isQuietHours(Date.parse(iso));
    expect(at("2026-11-24T12:59:59Z")).toBe(false);
    expect(at("2026-11-24T13:00:00Z")).toBe(true);
    expect(at("2026-11-24T15:00:00Z")).toBe(true);
    expect(at("2026-11-24T21:59:59Z")).toBe(true);
    expect(at("2026-11-24T22:00:00Z")).toBe(false);
    expect(at("2026-11-24T03:00:00Z")).toBe(false);
  });
});
