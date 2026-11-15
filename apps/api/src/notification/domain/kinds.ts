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

/**
 * 1日の上限の組（決定事項8）
 * - 誘い・募集・友達：利用者ごとにプッシュ30件・メール10件。全体のメール数は `MAIL_DAILY_LIMIT - 20` まで
 * - 予定・カレンダー：利用者ごとにプッシュ・メールそれぞれ30件（悪用の歯止め）。全体のメール数は `MAIL_DAILY_LIMIT` まで
 * - 新端末のログイン：利用者ごとにメール5件。全体の上限を超えていても送る（安全の通知を優先）
 * 数の行の `channel` は、組ごとに分ける（同じ利用者でも、組が違えば別に数える）
 */
export type LimitTier = "normal" | "priority" | "login";

export type DailyLimits = {
  tier: LimitTier;
  push: { counter: string; limit: number } | null;
  email: { counter: string; limit: number };
};

export const PUSH_DAILY_LIMIT = 30;
export const EMAIL_DAILY_LIMIT = 10;
export const PRIORITY_DAILY_LIMIT = 30;
export const LOGIN_EMAIL_DAILY_LIMIT = 5;
/** 誘い・募集・友達のメールは、全体の上限からこの数を残して止める（予定・カレンダー・新端末のログインの分） */
export const GLOBAL_PRIORITY_RESERVE = 20;

const NORMAL: ReadonlySet<Category> = new Set(["invites", "broadcasts", "friends"]);

export function limitsFor(kind: NotificationKind): DailyLimits {
  const category = CATEGORY_OF[kind];
  if (category === null) {
    return { tier: "login", push: null, email: { counter: "email_login", limit: LOGIN_EMAIL_DAILY_LIMIT } };
  }
  if (NORMAL.has(category)) {
    return {
      tier: "normal",
      push: { counter: "push", limit: PUSH_DAILY_LIMIT },
      email: { counter: "email", limit: EMAIL_DAILY_LIMIT },
    };
  }
  return {
    tier: "priority",
    push: { counter: "push_priority", limit: PRIORITY_DAILY_LIMIT },
    email: { counter: "email_priority", limit: PRIORITY_DAILY_LIMIT },
  };
}

/** サービス全体の1日のメール数のうち、その組が使える上限。null は上限なし（超えていても送る） */
export function globalEmailLimitFor(tier: LimitTier, mailDailyLimit: number): number | null {
  if (tier === "login") return null;
  if (tier === "priority") return mailDailyLimit;
  return Math.max(0, mailDailyLimit - GLOBAL_PRIORITY_RESERVE);
}

/** `MAIL_DAILY_LIMIT` の既定値。設定がない・正の整数でないときに使う */
export const DEFAULT_MAIL_DAILY_LIMIT = 90;

export function parseMailDailyLimit(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAIL_DAILY_LIMIT;
}

/** `NOTIFICATION_START_AT` を読む。正の整数（Unixミリ秒）でなければ null（未設定。お知らせを作らない） */
export function parseNotificationStartAt(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 1件ぶんの下書き（受け取り手ごと）。名前・ひとこと・時刻は持たない */
export type Draft = {
  userId: string;
  kind: NotificationKind;
  actorId: string | null;
  subjectId: string | null;
  count: number | null;
  device: string | null;
};
