import { z } from "zod";
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

/** 種別（設定の単位）ごとのオン／オフ */
export const notificationPreferencesSchema = z
  .object({
    invites: z.boolean(),
    broadcasts: z.boolean(),
    meetups: z.boolean(),
    friends: z.boolean(),
    calendar: z.boolean(),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const notificationPreferencesPatchSchema = notificationPreferencesSchema
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "at_least_one" });

export const vapidKeySchema = z.object({ publicKey: z.string().min(1) });

/** プッシュの購読。受け取るのは endpoint だけ（中身を送らないので、暗号化の鍵は受け取らない） */
export const pushSubscriptionRequestSchema = z.object({ endpoint: z.string().min(1).max(2048) }).strict();
