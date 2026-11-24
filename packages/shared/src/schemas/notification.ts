import * as z from "zod";
import { historyProfileSchema } from "./social";

// 通知（docs/specs/T-07-notification.md「API」）

export const notificationKindSchema = z.enum([
  "invite_received",
  "invite_declined",
  "invite_countered",
  "invite_skipped",
  "broadcast_received",
  "broadcast_decided",
  "meetup_confirmed",
  "meetup_cancelled",
  "meetup_left",
  "friend_added",
  "availability_cancelled",
  "calendar_reauth",
  "new_login",
]);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/** 項目は種類にかかわらず同じ。値がない項目は null */
export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  actor: historyProfileSchema.nullable(),
  subjectId: z.string().nullable(),
  count: z.number().int().nullable(),
  device: z.string().nullable(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export type NotificationDto = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});

export const unreadCountSchema = z.object({ count: z.number().int().min(0).max(99) });

export const markReadRequestSchema = z.object({ upTo: z.uuid() }).strict();

/**
 * ロック画面に出す中身（docs/specs/T-35-notification-visibility.md）。
 * hidden：種類だけ（初期値）。detailed：相手の名前と日時も（ひとこと・エリア・リンクはどちらでも出さない）
 */
export const lockScreenSchema = z.enum(["hidden", "detailed"]);
export type LockScreen = z.infer<typeof lockScreenSchema>;

/** 種別（設定の単位）ごとのオン／オフと、ロック画面の見え方（T-35） */
export const notificationPreferencesSchema = z
  .object({
    invites: z.boolean(),
    broadcasts: z.boolean(),
    meetups: z.boolean(),
    friends: z.boolean(),
    calendar: z.boolean(),
    lockScreen: lockScreenSchema,
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const notificationPreferencesPatchSchema = notificationPreferencesSchema
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "at_least_one" });

export const vapidKeySchema = z.object({ publicKey: z.string().min(1) });

const base64url = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}={0,2}$`));

/**
 * プッシュの購読の登録。endpoint と、中身の暗号化（RFC 8291）に使う鍵（T-35）。
 * p256dh は非圧縮の P-256 の点（65バイト）、auth は16バイト（どちらも base64url）。
 * 鍵がない登録（T-35 より前の画面）も受け付け、その購読には本文のないプッシュを送る
 */
export const pushSubscriptionRequestSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    keys: z.object({ p256dh: base64url(65), auth: base64url(16) }).strict().optional(),
  })
  .strict();
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

/** プッシュの購読の解除。endpoint だけ（鍵は受け取らない） */
export const pushUnsubscribeRequestSchema = z.object({ endpoint: z.string().min(1).max(2048) }).strict();
