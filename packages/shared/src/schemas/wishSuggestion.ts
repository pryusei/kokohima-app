import * as z from "zod";
import { areaSchema, freeText, linkUrlSchema, messageSchema } from "./invitation";

// 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md「API」）

/** 「何をしたい？」の文字数の上限（改行なし） */
export const SUGGEST_QUERY_MAX = 60;
/** 候補の数の上限（決めたこと1） */
export const SUGGEST_MAX_CANDIDATES = 3;
/** 店・場所の名前と、選んだ理由の文字数の上限 */
export const SUGGEST_PLACE_NAME_MAX = 40;
export const SUGGEST_REASON_MAX = 40;

const required = <T extends z.ZodType<string | null>>(schema: T) =>
  schema.refine((v) => v !== null, { message: "required" });

export const createWishSuggestionRequestSchema = z
  .object({
    area: required(areaSchema),
    query: required(freeText(SUGGEST_QUERY_MAX, 0)),
  })
  .strict();
export type CreateWishSuggestionRequest = z.input<typeof createWishSuggestionRequestSchema>;

/** 1つの候補。API の検査（domain）を通ったものだけが画面に届く */
export const wishSuggestionCandidateSchema = z.object({
  message: required(messageSchema),
  placeName: required(freeText(SUGGEST_PLACE_NAME_MAX, 0)),
  url: linkUrlSchema.refine((v) => v !== null, { message: "required" }),
  reason: required(freeText(SUGGEST_REASON_MAX, 0)),
  /** 店の地域名か最寄り駅（30文字まで）。なければ null（置くシートには探したときのエリアを入れる） */
  area: areaSchema,
});
export type WishSuggestionCandidate = { message: string; placeName: string; url: string; reason: string; area: string | null };

/** ストリームのイベント（`event:` の名前と `data:` の JSON） */
export const wishSuggestionProgressSchema = z.object({ stage: z.enum(["searching", "choosing"]) });
export const wishSuggestionResultSchema = z.object({
  candidates: z.array(wishSuggestionCandidateSchema).max(SUGGEST_MAX_CANDIDATES),
});
export type WishSuggestionProgress = z.infer<typeof wishSuggestionProgressSchema>;
export type WishSuggestionResult = { candidates: WishSuggestionCandidate[] };

/** 今日あと何回探せるか（探せる回数と試せる回数の残りの小さい方）。limit が0なら機能を出さない */
export const wishSuggestionQuotaSchema = z.object({
  remaining: z.number().int().min(0),
  limit: z.number().int().min(0),
});
export type WishSuggestionQuota = z.infer<typeof wishSuggestionQuotaSchema>;
