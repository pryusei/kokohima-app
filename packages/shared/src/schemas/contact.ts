import { z } from "zod";

// 問い合わせ（docs/specs/T-24-contact.md「API」）。API・consumer・画面で同じ値を使う

export const CONTACT_CATEGORIES = ["bug", "feedback", "privacy_request", "other"] as const;
export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

/** 種類の表示の名前（画面のチップと、Slack に送る文の見出し） */
export const CONTACT_CATEGORY_LABELS: Record<ContactCategory, string> = {
  bug: "不具合",
  feedback: "ご意見",
  privacy_request: "個人情報の開示・削除の請求",
  other: "その他",
};

/** 内容の上限（コードポイントで数える。ひとことの messageSchema と同じ数え方） */
export const CONTACT_BODY_MAX = 1000;
/** 受け取る生の文字列の上限（UTF-16 の長さ。正規化の前の歯止め。内容の上限の8倍） */
export const CONTACT_BODY_RAW_MAX = CONTACT_BODY_MAX * 8;
/** 回数の上限：1人あたり、直近 CONTACT_LIMIT_WINDOW_HOURS 時間に CONTACT_DAILY_LIMIT 件まで */
export const CONTACT_DAILY_LIMIT = 3;
export const CONTACT_LIMIT_WINDOW_HOURS = 24;

// 改行を除く制御文字・孤立サロゲート・書字方向を変える文字。ほかの書式文字（絵文字をつなぐ U+200D など）は許す
// （運営者だけが読む文章で、見た目の偽装の害が小さいため）
const FORBIDDEN = /[\p{Cc}\p{Cs}‪-‮⁦-⁩]/u;

/** 内容の正規化：改行を \n に、タブを空白1つにそろえ、NFC にし、前後の空白を除く */
export function normalizeContactBody(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ").normalize("NFC").trim();
}

/** 内容の長さ（正規化のあとのコードポイントの数）。画面の文字数の表示も同じ数え方 */
export const contactBodyLength = (raw: string) => Array.from(normalizeContactBody(raw)).length;

export const contactBodySchema = z
  .string()
  .max(CONTACT_BODY_RAW_MAX, { message: "too_long" })
  .transform(normalizeContactBody)
  .refine((v) => v.length > 0, { message: "too_short" })
  .refine((v) => Array.from(v).length <= CONTACT_BODY_MAX, { message: "too_long" })
  .refine((v) => !FORBIDDEN.test(v.replace(/\n/g, "")), { message: "invalid_characters" });

/** 送り主はいつもアクセストークンの閲覧者。本文に userId・email などを入れると .strict() で400 */
export const contactMessageRequestSchema = z
  .object({
    category: z.enum(CONTACT_CATEGORIES),
    body: contactBodySchema,
  })
  .strict();
export type ContactMessageRequest = z.input<typeof contactMessageRequestSchema>;
