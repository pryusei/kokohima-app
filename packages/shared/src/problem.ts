import { z } from "zod";

// APIのエラー形式（RFC 9457 Problem Details）。api-conventions スキルの「エラー」に対応する
export const errorCodeSchema = z.enum([
  "validation_failed",
  "unauthenticated",
  "not_found",
  "invalid_state",
  "expired",
  "rate_limited",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: errorCodeSchema,
  requestId: z.string(),
  errors: z
    .array(z.object({ path: z.string(), code: z.string() }))
    .optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
