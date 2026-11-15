import { describe, expect, it } from "vitest";
import { localDay } from "./day";
import { pushEndpointOrigin } from "./endpoint";
import { draftsFor } from "./events";
import { CATEGORY_OF, countsTowardDailyLimit } from "./kinds";
import { mailFor } from "./mail";

// 通知のドメイン（docs/specs/T-07-notification.md「お知らせの作り方」「入力」「メールの中身」）

const at = "2026-10-10T00:00:00.000Z";

describe("イベント → お知らせ", () => {
  it("誘い：受け取り手は userId、相手は actorId", () => {
    for (const [type, kind] of [
      ["DirectInviteSent", "invite_received"],
      ["DirectInviteDeclined", "invite_declined"],
      ["DirectInviteCounterProposed", "invite_countered"],
      ["DirectInviteSkipped", "invite_skipped"],
    ] as const) {
      expect(draftsFor(type, { userId: "u1", inviteId: "i1", actorId: "u2", occurredAt: at })).toEqual([
        { userId: "u1", kind, actorId: "u2", subjectId: "i1", count: null, device: null },
      ]);
    }
  });

  it("募集：宛先ごとに届く。決まったことは募集者を除く参加者に届く", () => {
    expect(draftsFor("BroadcastSent", { userId: "u1", broadcastId: "b1", actorId: "o" })).toEqual([
      { userId: "u1", kind: "broadcast_received", actorId: "o", subjectId: "b1", count: null, device: null },
    ]);
    const decided = draftsFor(
      "BroadcastDecided",
      { meetupId: "m1", broadcastId: "b1", participantIds: ["o", "u1", "u2"] },
      { broadcastOwner: "o" },
    );
    expect(decided.map((d) => d.userId)).toEqual(["u1", "u2"]);
    expect(decided.every((d) => d.kind === "broadcast_decided" && d.actorId === "o" && d.subjectId === "b1")).toBe(true);
  });

  it("成立：募集の予定（inviteId が null）では作らない。直接の誘いは成立させた人を除く", () => {
    expect(draftsFor("MeetupConfirmed", { meetupId: "m1", inviteId: null, broadcastId: "b1", participantIds: ["a", "b"] })).toEqual([]);
    expect(draftsFor("MeetupConfirmed", { meetupId: "m1", broadcastId: "b1", participantIds: ["a", "b"] })).toEqual([]);
    const drafts = draftsFor("MeetupConfirmed", { meetupId: "m1", inviteId: "i1", participantIds: ["a", "b"] }, { inviteActor: "b" });
    expect(drafts).toEqual([{ userId: "a", kind: "meetup_confirmed", actorId: "b", subjectId: "m1", count: null, device: null }]);
  });

  it("キャンセルは押した人を除く。抜けたことは残った人に届き、相手の名前を持たない", () => {
    const cancelled = draftsFor("MeetupCancelled", { meetupId: "m1", actorId: "a", participantIds: ["a", "b", "c"] });
    expect(cancelled.map((d) => d.userId)).toEqual(["b", "c"]);
    expect(cancelled.every((d) => d.actorId === null)).toBe(true);
    const left = draftsFor("MeetupLeft", { meetupId: "m1", actorId: "x", participantIds: ["a", "b"] });
    expect(left.map((d) => [d.userId, d.actorId])).toEqual([
      ["a", null],
      ["b", null],
    ]);
  });

  it("友達・自動取り消し・連携の失効", () => {
    expect(draftsFor("FriendshipEstablished", { userId: "a", friendId: "b" })[0]).toMatchObject({
      userId: "a",
      kind: "friend_added",
      actorId: "b",
      subjectId: "b",
    });
    expect(
      draftsFor("AvailabilityCancelledByCalendar", { userId: "a", ranges: [{}, {}, {}] })[0],
    ).toMatchObject({ kind: "availability_cancelled", count: 3, actorId: null });
    expect(draftsFor("CalendarReauthRequired", { userId: "a", provider: "google" })[0]?.kind).toBe("calendar_reauth");
  });

  it("新端末のログイン：前のセッションがあるときだけ。端末の要約を持つ", () => {
    const payload = { userId: "a", sessionId: "s2", deviceSummary: "Safari / iOS" };
    expect(draftsFor("SessionStarted", payload, { hasEarlierSession: false })).toEqual([]);
    expect(draftsFor("SessionStarted", payload, { hasEarlierSession: true })[0]).toMatchObject({
      kind: "new_login",
      device: "Safari / iOS",
    });
  });

  it("お知らせにしない型は空", () => {
    expect(draftsFor("CalendarConnected", { userId: "a" })).toEqual([]);
    expect(draftsFor("SomethingElse", { userId: "a" })).toEqual([]);
  });
});

describe("種別と上限", () => {
  it("新端末のログインは種別を持たない（止められない）", () => {
    expect(CATEGORY_OF.new_login).toBeNull();
  });

  it("1日の上限に数えるのは誘い・募集・友達だけ（予定・カレンダー・新端末のログインは必ず送る）", () => {
    expect(countsTowardDailyLimit("invite_received")).toBe(true);
    expect(countsTowardDailyLimit("broadcast_received")).toBe(true);
    expect(countsTowardDailyLimit("friend_added")).toBe(true);
    expect(countsTowardDailyLimit("meetup_cancelled")).toBe(false);
    expect(countsTowardDailyLimit("calendar_reauth")).toBe(false);
    expect(countsTowardDailyLimit("new_login")).toBe(false);
  });

  it("日付は利用者のタイムゾーンで区切る", () => {
    expect(localDay(Date.parse("2026-10-10T14:59:00Z"), "Asia/Tokyo")).toBe("2026-10-10");
    expect(localDay(Date.parse("2026-10-10T15:00:00Z"), "Asia/Tokyo")).toBe("2026-10-11");
  });
});

describe("プッシュの endpoint", () => {
  it("知られたプッシュのサービスだけを受け付け、オリジンを返す", () => {
    expect(pushEndpointOrigin("https://fcm.googleapis.com/fcm/send/abc")).toBe("https://fcm.googleapis.com");
    expect(pushEndpointOrigin("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(
      "https://updates.push.services.mozilla.com",
    );
    expect(pushEndpointOrigin("https://web.push.apple.com/Qabc")).toBe("https://web.push.apple.com");
    expect(pushEndpointOrigin("https://api.push.apple.com/3/device/x")).toBe("https://api.push.apple.com");
    expect(pushEndpointOrigin("https://db5.notify.windows.com/w/?token=x")).toBe("https://db5.notify.windows.com");
    expect(pushEndpointOrigin("https://FCM.googleapis.com/fcm/send/abc")).toBe("https://fcm.googleapis.com");
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://example.com/push",
    "https://evil-push.apple.com.attacker.test/x",
    "https://push.apple.com.evil.test/x",
    "https://evilpush.apple.com/x",
    "https://push.apple.com/x",
    "https://notify.windows.com/x",
    "https://127.0.0.1/x",
    "https://[::1]/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pass@fcm.googleapis.com/x",
    "https://user@fcm.googleapis.com/x",
    "not a url",
    "",
    `https://fcm.googleapis.com/${"a".repeat(2048)}`,
  ])("受け付けない：%s", (endpoint) => {
    expect(pushEndpointOrigin(endpoint)).toBeNull();
  });

  it("追加のホスト（E2E 用）は、渡したときだけ受け付ける", () => {
    expect(pushEndpointOrigin("https://push.e2e.invalid/x")).toBeNull();
    expect(pushEndpointOrigin("https://push.e2e.invalid/x", ["push.e2e.invalid"])).toBe("https://push.e2e.invalid");
  });
});

describe("メールの文面", () => {
  const app = { origin: "https://app.test", timezone: "Asia/Tokyo" };

  it("お知らせのメールは種類の説明とアプリのトップだけ。ログイン用のリンクを入れない", () => {
    const mail = mailFor({ kind: "invite_received", device: null, createdAt: 0 }, app);
    expect(mail.subject).toBe("ここ暇：新しいお知らせがあります");
    expect(mail.text).toContain("誘いが届きました");
    expect(mail.text).toContain("https://app.test");
    expect(mail.text).not.toMatch(/https:\/\/app\.test\/\S/);
    expect(mail.text).toContain("通知はアプリの設定で止められます");
  });

  it("断り・キャンセルは静かな文言で、理由を書かない", () => {
    expect(mailFor({ kind: "invite_declined", device: null, createdAt: 0 }, app).text).toContain("誘いに返事がありました");
    expect(mailFor({ kind: "meetup_cancelled", device: null, createdAt: 0 }, app).text).toContain("予定がなくなりました");
  });

  it("新端末のログインは、端末の要約とログインの日時（利用者のタイムゾーン）", () => {
    const mail = mailFor({ kind: "new_login", device: "Chrome / Windows", createdAt: Date.parse("2026-10-10T00:00:00Z") }, app);
    expect(mail.subject).toBe("ここ暇：新しい端末でログインがありました");
    expect(mail.text).toContain("Chrome / Windows");
    expect(mail.text).toContain("2026/10/10 9:00");
    expect(mail.text).toContain("すべての端末からログアウト");
  });
});
