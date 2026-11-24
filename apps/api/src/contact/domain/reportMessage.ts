import { REPORT_REASON_LABELS, type ReportReason } from "@kokohima/shared";
import { escapeSlack, formatJst, splitEscaped } from "./slackMessage";

// 通報を Slack に送る文（docs/specs/T-33-block-report.md「振る舞い 5.」）。純粋な関数だけ。
// 問い合わせ（slackMessage.ts）と同じ決まり：利用者が書いたもの・相手が書いたもの（ひとこと・リンク・エリア）は plain_text の欄にだけ入れ、
// すべての文字列の &・<・> をエスケープし、リンクの展開を止める。text（通知の要約）は「通報：<理由>」だけ

export type ReportSubjectForSlack = {
  type: "direct_invite" | "broadcast";
  id: string;
  /** ISO 8601（UTC） */
  startsAt: string;
  endsAt: string;
  area: string | null;
  message: string | null;
  url: string | null;
};

export type ReportForSlack = {
  reason: ReportReason;
  /** 通報した人（閲覧者）の ID */
  reporterId: string;
  /** 通報された人の ID */
  targetUserId: string;
  /** 受け付けた時刻（ISO 8601、UTC） */
  occurredAt: string;
  /** 受付番号（outbox の行の id） */
  receiptId: string;
  /** 検証と正規化のあとのくわしく。なければ null */
  details: string | null;
  alsoBlock: boolean;
  subject: ReportSubjectForSlack | null;
};

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: false });
const SUBJECT_LABELS = { direct_invite: "誘い", broadcast: "募集" } as const;

/** 「YYYY-MM-DD HH:mm〜HH:mm（日本時間）」。日をまたぐときは終わりにも日付を付ける */
export function formatJstRange(startsAt: string, endsAt: string): string {
  const s = formatJst(startsAt).replace("（日本時間）", "");
  const e = formatJst(endsAt).replace("（日本時間）", "");
  const sameDay = s.slice(0, 10) === e.slice(0, 10);
  return `${s}〜${sameDay ? e.slice(11) : e}（日本時間）`;
}

/** Incoming Webhook の JSON */
export function buildReportSlackMessage(r: ReportForSlack) {
  const title = escapeSlack(`通報：${REPORT_REASON_LABELS[r.reason]}`);
  const subjectBlocks = r.subject
    ? [
        {
          type: "section",
          fields: [
            plain(escapeSlack(`対象：${SUBJECT_LABELS[r.subject.type]}（${r.subject.id}）`)),
            plain(escapeSlack(`日時：${formatJstRange(r.subject.startsAt, r.subject.endsAt)}`)),
            plain(escapeSlack(`エリア：${r.subject.area ?? "なし"}`)),
          ],
        },
        // リンクは長くなりうるので、fields（2000文字）ではなく section（3000文字ずつ）に入れる
        ...splitEscaped(`リンク：${r.subject.url ?? "なし"}`).map((text) => ({ type: "section", text: plain(text) })),
        ...(r.subject.message
          ? splitEscaped(`ひとこと：${r.subject.message}`).map((text) => ({ type: "section", text: plain(text) }))
          : []),
      ]
    : [];
  return {
    text: title,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "header", text: plain(title) },
      {
        type: "section",
        fields: [
          plain(escapeSlack(`通報した人：${r.reporterId}`)),
          plain(escapeSlack(`通報された人：${r.targetUserId}`)),
          plain(escapeSlack(`受付：${formatJst(r.occurredAt)}`)),
          plain(escapeSlack(`受付番号：${r.receiptId}`)),
          plain(escapeSlack(`ブロック：${r.alsoBlock ? "した" : "していない"}`)),
        ],
      },
      ...subjectBlocks,
      ...(r.details ? splitEscaped(`くわしく：${r.details}`).map((text) => ({ type: "section", text: plain(text) })) : []),
    ],
  };
}
