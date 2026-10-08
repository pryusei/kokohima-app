import { z } from "zod";
import { pageSchema } from "./pagination";
import { publicProfileSchema } from "./social";

// 個別の誘いと成立した予定（docs/specs/T-04-direct-invite.md「API」）
// 現在時刻によらない規則（15分単位・長さ・文字数・URLの形）だけをここで検証する。未来・60日以内・期限は API の domain

const MINUTE_MS = 60 * 1000;
export const INVITE_QUARTER_MS = 15 * MINUTE_MS;
export const INVITE_MIN_LENGTH_MS = 30 * MINUTE_MS;
export const INVITE_MAX_LENGTH_MS = 24 * 60 * MINUTE_MS;
export const AREA_MAX = 30;
export const MESSAGE_MAX = 100;
export const MESSAGE_MAX_NEWLINES = 5;
export const URL_MAX = 2048;

// T-02 の表示名と同じく、見た目を偽装できる文字は拒否する（ひとことの改行だけは別に許す）
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const codePoints = (v: string) => Array.from(v).length;

/** 空なら null。前後の空白を除き、NFC にそろえる */
function freeText(max: number, newlines: number) {
  return z
    .string()
    .max(max * 8)
    .nullish()
    .transform((v) => {
      if (v == null) return null;
      const text = v.replace(/\r\n/g, "\n").normalize("NFC").trim();
      return text === "" ? null : text;
    })
    .refine((v) => v === null || codePoints(v) <= max, { message: "too_long" })
    .refine((v) => v === null || (v.match(/\n/g)?.length ?? 0) <= newlines, { message: "too_many_newlines" })
    .refine((v) => v === null || !INVISIBLE_OR_CONTROL.test(v.replace(/\n/g, "")), { message: "invalid_characters" });
}

export const areaSchema = freeText(AREA_MAX, 0);
export const messageSchema = freeText(MESSAGE_MAX, MESSAGE_MAX_NEWLINES);

// shared は DOM の型を読まないので、Workers とブラウザの両方にある WHATWG URL を最小の型で使う
type ParsedUrl = { protocol: string; username: string; password: string; hostname: string };
const UrlCtor = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL;

/** リンクの表示用のドメイン。国際化ドメインは punycode（xn--…）になり、見た目による偽装を防ぐ。解釈できなければ null */
export function linkHostname(url: string): string | null {
  try {
    return new UrlCtor(url).hostname;
  } catch {
    return null;
  }
}

/** http・https だけ。認証情報（user:pass@）を含む URL は不可 */
export const linkUrlSchema = z
  .string()
  .max(URL_MAX)
  .nullish()
  .transform((v) => v ?? null)
  .refine(
    (v) => {
      if (v === null) return true;
      try {
        const url = new UrlCtor(v);
        return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    },
    { message: "invalid_url" },
  );

/** 15分単位、長さ30分以上24時間以下 */
export function isValidInviteRange(startsAt: string, endsAt: string) {
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  const length = end - start;
  return (
    start % INVITE_QUARTER_MS === 0 &&
    end % INVITE_QUARTER_MS === 0 &&
    length >= INVITE_MIN_LENGTH_MS &&
    length <= INVITE_MAX_LENGTH_MS
  );
}

const rangeShape = { startsAt: z.iso.datetime(), endsAt: z.iso.datetime() };
const validRange = (v: { startsAt: string; endsAt: string }) => isValidInviteRange(v.startsAt, v.endsAt);
const rangeIssue = { message: "invalid_range", path: ["startsAt"] };

export const inviteKindSchema = z.enum(["asobo", "kokodou"]);
export type InviteKind = z.infer<typeof inviteKindSchema>;

export const expiresInSchema = z.enum(["1h", "3h", "24h", "until_start"]);
export type ExpiresIn = z.infer<typeof expiresInSchema>;

export const createDirectInviteRequestSchema = z
  .object({
    recipientId: z.uuid(),
    ...rangeShape,
    area: areaSchema,
    message: messageSchema,
    url: linkUrlSchema,
    expiresIn: expiresInSchema.default("until_start"),
  })
  .strict()
  .refine(validRange, rangeIssue);
export type CreateDirectInviteRequest = z.infer<typeof createDirectInviteRequestSchema>;

export const respondDirectInviteRequestSchema = z.discriminatedUnion("response", [
  z.object({ response: z.literal("accept") }).strict(),
  z.object({ response: z.literal("decline") }).strict(),
  z
    .object({ response: z.literal("counter"), ...rangeShape })
    .strict()
    .refine(validRange, rangeIssue),
]);
export type RespondDirectInviteRequest = z.infer<typeof respondDirectInviteRequestSchema>;

export const decideDirectInviteRequestSchema = z.object({ decision: z.enum(["accept", "skip"]) }).strict();
export type DecideDirectInviteRequest = z.infer<typeof decideDirectInviteRequestSchema>;

export const inviteBoxSchema = z.enum(["received", "sent"]);

export const directInviteStatusSchema = z.enum([
  "pending",
  "counter_proposed",
  "confirmed",
  "declined",
  "skipped",
  "expired",
  "cancelled",
]);
export type DirectInviteStatus = z.infer<typeof directInviteStatusSchema>;

export const directInviteSchema = z.object({
  id: z.uuid(),
  kind: inviteKindSchema,
  direction: inviteBoxSchema,
  counterpart: publicProfileSchema,
  status: directInviteStatusSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  area: z.string().nullable(),
  message: z.string().nullable(),
  url: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  counterProposal: z.object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() }).nullable(),
  meetupId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type DirectInvite = z.infer<typeof directInviteSchema>;
export const directInvitePageSchema = pageSchema(directInviteSchema);

export const meetupSchema = z.object({
  id: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: z.enum(["confirmed", "cancelled"]),
  participants: z.array(publicProfileSchema),
  area: z.string().nullable(),
  message: z.string().nullable(),
  url: z.string().nullable(),
  directInviteId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Meetup = z.infer<typeof meetupSchema>;
export const meetupPageSchema = pageSchema(meetupSchema);
