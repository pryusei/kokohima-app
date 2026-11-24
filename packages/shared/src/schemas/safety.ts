import * as z from "zod";
import { contactBodySchema } from "./contact";
import { pageSchema } from "./pagination";
import { historyProfileSchema } from "./social";

// ブロックと通報（docs/specs/T-33-block-report.md「API」）。API・consumer・画面で同じ値を使う

/** 通報の理由（並びは画面のチップの順） */
export const REPORT_REASONS = ["repeated_invites", "offensive_content", "stranger_or_impersonation", "unsafe_meetup", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** 理由の表示の名前（画面のチップと、Slack に送る文の見出し） */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  repeated_invites: "何度も誘われる",
  offensive_content: "ひとこと・リンクが不快",
  stranger_or_impersonation: "知らない人・なりすまし",
  unsafe_meetup: "会うのが不安な誘い",
  other: "その他",
};

/** くわしく（任意）の上限。数え方・正規化・使えない文字は問い合わせの内容（contactBodySchema）と同じ */
export const REPORT_DETAILS_MAX = 1000;
/** 回数の上限：1人あたり、直近 REPORT_LIMIT_WINDOW_HOURS 時間に REPORT_DAILY_LIMIT 件まで */
export const REPORT_DAILY_LIMIT = 5;
export const REPORT_LIMIT_WINDOW_HOURS = 24;

/** 対象（届いた誘い・届いた募集）。指すのは ID だけで、中身はサーバーが閲覧者の権限で読む */
export const safetySubjectSchema = z
  .object({
    type: z.enum(["direct_invite", "broadcast"]),
    id: z.uuid(),
  })
  .strict();
export type SafetySubject = z.infer<typeof safetySubjectSchema>;

/** ブロックする。相手は、今の友達か、subject を閲覧者に送った人 */
export const createBlockRequestSchema = z
  .object({
    userId: z.uuid(),
    subject: safetySubjectSchema.optional(),
  })
  .strict();
export type CreateBlockRequest = z.input<typeof createBlockRequestSchema>;

/** ブロックした人の一覧の1行 */
export const blockedUserSchema = z.object({
  user: historyProfileSchema,
  blockedAt: z.iso.datetime(),
});
export type BlockedUser = z.infer<typeof blockedUserSchema>;
export const blockedUserPageSchema = pageSchema(blockedUserSchema);

/** 通報する。送り主はいつもアクセストークンの閲覧者（本文に送り主を入れると .strict() で400） */
export const reportRequestSchema = z
  .object({
    userId: z.uuid(),
    reason: z.enum(REPORT_REASONS),
    details: contactBodySchema.optional(),
    subject: safetySubjectSchema.optional(),
    alsoBlock: z.boolean(),
  })
  .strict();
export type ReportRequest = z.input<typeof reportRequestSchema>;
