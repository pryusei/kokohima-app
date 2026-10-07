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

// 表示名（docs/specs/T-02-friends.md「表示名」）。受け口で発行者を確かめる手がかりなので、見た目を偽装できる文字は拒否する
// NFC で正規化して前後の空白を除き、コードポイントで1〜20文字。
// 制御文字（C0・C1）、書式文字（書字方向の上書き、幅のない文字など）、私用領域、孤立サロゲート、行・段落の区切りは不可
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
export const displayNameSchema = z
  .string()
  .max(200)
  .transform((v) => v.normalize("NFC").trim())
  .refine((v) => {
    const length = Array.from(v).length;
    return length >= 1 && length <= 20;
  }, { message: "length" })
  .refine((v) => !INVISIBLE_OR_CONTROL.test(v), { message: "invalid_characters" });

export const updateMeRequestSchema = z.object({ displayName: displayNameSchema });
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
