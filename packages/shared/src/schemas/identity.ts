import { z } from "zod";

// 認証（identity）のリクエストとレスポンス。docs/specs/T-01-auth.md の「API」に対応する

export const authStartQuerySchema = z.object({
  // 形の検証はサーバーの sanitizeReturnTo で行い、満たさなければ "/" に置き換える
  returnTo: z.string().max(2048).optional(),
});
export type AuthStartQuery = z.infer<typeof authStartQuerySchema>;

export const authCompleteRequestSchema = z.object({
  code: z.string().min(1).max(128),
});
export type AuthCompleteRequest = z.infer<typeof authCompleteRequestSchema>;

export const accessTokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresAt: z.iso.datetime(),
});

export const authCompleteResponseSchema = accessTokenResponseSchema.extend({
  returnTo: z.string(),
});
export type AuthCompleteResponse = z.infer<typeof authCompleteResponseSchema>;

export const refreshResponseSchema = accessTokenResponseSchema;
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const meResponseSchema = z.object({
  id: z.uuid(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// 表示名（docs/specs/T-02-friends.md「表示名」）。前後の空白を除いて1〜20文字、制御文字は不可
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .refine((v) => !CONTROL.test(v), { message: "control_characters" });

export const updateMeRequestSchema = z.object({ displayName: displayNameSchema });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
