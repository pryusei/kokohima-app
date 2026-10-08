import { z } from "zod";
import { publicProfileSchema } from "./social";

// ここ暇（docs/specs/T-03-availability.md「API」）

export const presetNameSchema = z.enum(["day", "evening", "night"]);
export type PresetName = z.infer<typeof presetNameSchema>;

/** "HH:MM"（15分単位）。終了には "24:00" も使える */
export const hhmmSchema = z.string().regex(/^(?:[01]\d|2[0-3]):(?:00|15|30|45)$|^24:00$/);

export const presetRangeSchema = z.object({ start: hhmmSchema, end: hhmmSchema });
export const presetsSchema = z.object({
  day: presetRangeSchema,
  evening: presetRangeSchema,
  night: presetRangeSchema,
});
export type Presets = z.infer<typeof presetsSchema>;

export const DEFAULT_PRESETS: Presets = {
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
};

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createAvailabilityRequestSchema = z.union([
  z.object({ date: localDateSchema, preset: presetNameSchema }).strict(),
  z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).strict(),
]);
export type CreateAvailabilityRequest = z.infer<typeof createAvailabilityRequestSchema>;

export const slotSchema = z.object({
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  label: presetNameSchema.nullable(),
});
export type SlotDto = z.infer<typeof slotSchema>;

/** 自分の一覧の項目。一意なキーは (source, id, date) */
export const myAvailabilitySchema = slotSchema.extend({
  source: z.enum(["manual", "recurrence"]),
  id: z.uuid(),
  date: localDateSchema.nullable(),
});
export type MyAvailability = z.infer<typeof myAvailabilitySchema>;

export const friendAvailabilitySchema = slotSchema.extend({
  friend: publicProfileSchema,
  overlapsMine: z.boolean(),
});
export type FriendAvailability = z.infer<typeof friendAvailabilitySchema>;

export const createRecurrenceRuleRequestSchema = z.union([
  z.object({ weekday: z.number().int().min(0).max(6), preset: presetNameSchema }).strict(),
  z.object({ weekday: z.number().int().min(0).max(6), start: hhmmSchema, end: hhmmSchema }).strict(),
]);
export type CreateRecurrenceRuleRequest = z.infer<typeof createRecurrenceRuleRequestSchema>;

export const recurrenceRuleSchema = z.object({
  id: z.uuid(),
  weekday: z.number().int(),
  start: hhmmSchema,
  end: hhmmSchema,
  label: presetNameSchema.nullable(),
  timezone: z.string(),
  exceptions: z.array(localDateSchema),
  createdAt: z.iso.datetime(),
});
export type RecurrenceRuleDto = z.infer<typeof recurrenceRuleSchema>;

export const recurrenceExceptionRequestSchema = z.object({ date: localDateSchema });

export const rangeQuerySchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime(), cursor: z.string().max(256).optional() })
  .refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: "from_must_be_before_to" });

export const myAvailabilityListSchema = z.object({ items: z.array(myAvailabilitySchema), nextCursor: z.null() });
export const friendAvailabilityPageSchema = z.object({
  items: z.array(friendAvailabilitySchema),
  nextCursor: z.string().nullable(),
});
export const slotListSchema = z.object({ items: z.array(slotSchema), nextCursor: z.null() });
export const recurrenceRuleListSchema = z.object({ items: z.array(recurrenceRuleSchema), nextCursor: z.null() });
