// お知らせの種類と種別（docs/specs/T-07-notification.md「お知らせの作り方」）

export type NotificationKind =
  | "invite_received"
  | "invite_declined"
  | "invite_countered"
  | "invite_skipped"
  | "broadcast_received"
  | "broadcast_decided"
  | "meetup_confirmed"
  | "meetup_cancelled"
  | "meetup_left"
  | "friend_added"
  | "availability_cancelled"
  | "calendar_reauth"
  | "new_login";

/** 設定の単位。new_login は止められないので種別を持たない */
export type Category = "invites" | "broadcasts" | "meetups" | "friends" | "calendar";

export const CATEGORY_OF: Record<NotificationKind, Category | null> = {
  invite_received: "invites",
  invite_declined: "invites",
  invite_countered: "invites",
  invite_skipped: "invites",
  broadcast_received: "broadcasts",
  broadcast_decided: "broadcasts",
  meetup_confirmed: "meetups",
  meetup_cancelled: "meetups",
  meetup_left: "meetups",
  friend_added: "friends",
  availability_cancelled: "calendar",
  calendar_reauth: "calendar",
  new_login: null,
};

/** 1日の上限に数える種別（決定事項8）。予定・カレンダー・新端末のログインは数えず、必ず送る */
const LIMITED: ReadonlySet<Category> = new Set(["invites", "broadcasts", "friends"]);

export const countsTowardDailyLimit = (kind: NotificationKind) => {
  const category = CATEGORY_OF[kind];
  return category !== null && LIMITED.has(category);
};

export const PUSH_DAILY_LIMIT = 30;
export const EMAIL_DAILY_LIMIT = 10;

/** 1件ぶんの下書き（受け取り手ごと）。名前・ひとこと・時刻は持たない */
export type Draft = {
  userId: string;
  kind: NotificationKind;
  actorId: string | null;
  subjectId: string | null;
  count: number | null;
  device: string | null;
};
