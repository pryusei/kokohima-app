import { z } from "zod";
import { presetNameSchema } from "./availability";

// カレンダー連携（docs/specs/T-06-calendar.md「API」）

export const calendarConnectionStatusSchema = z.enum(["connected", "needs_reauth", "none"]);
export type CalendarConnectionStatus = z.infer<typeof calendarConnectionStatusSchema>;

export const calendarConnectionsSchema = z.object({
  google: z.object({
    status: calendarConnectionStatusSchema,
    connectedAt: z.iso.datetime().nullable(),
  }),
});
export type CalendarConnections = z.infer<typeof calendarConnectionsSchema>;

export const calendarAuthorizationSchema = z.object({ authorizeUrl: z.url() });

export const freeSlotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preset: presetNameSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export type FreeSlot = z.infer<typeof freeSlotSchema>;

export const freeSlotsSchema = z.object({
  status: z.enum(["ok", "none", "needs_reauth", "unavailable"]),
  items: z.array(freeSlotSchema),
  nextCursor: z.null(),
});
export type FreeSlots = z.infer<typeof freeSlotsSchema>;

export const icsLinkSchema = z.object({ url: z.url(), expiresAt: z.iso.datetime() });
export type IcsLink = z.infer<typeof icsLinkSchema>;
