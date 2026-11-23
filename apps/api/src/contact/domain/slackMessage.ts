import { CONTACT_CATEGORY_LABELS, type ContactCategory } from "@kokohima/shared";

// Slack の Incoming Webhook に送る文（docs/specs/T-24-contact.md「振る舞い 4.」）。純粋な関数だけ
// - 利用者が書いたもの（内容）と外から来たもの（メールアドレス）は plain_text の欄にだけ入れ、emoji: false にする
// - 送るすべての文字列の &・<・> をエスケープする（Slack が書式の制御に使う3つの文字）
// - text（通知の要約）は「問い合わせ：<種類>」だけ。リンクの展開を止める

/** section の text の上限（Slack。UTF-16 の長さ） */
export const SECTION_TEXT_MAX = 3000;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** &・<・> を &amp;・&lt;・&gt; にする */
export const escapeSlack = (s: string) => s.replace(/[&<>]/g, (ch) => ESCAPES[ch] ?? ch);

/**
 * エスケープしたあとの内容を、max（UTF-16 の長さ）以下の塊に分ける。エスケープの前の内容をコードポイントで1つずつ見て、
 * 足すと max を超えるところで次の塊に移る（&amp; などの途中と、サロゲートペアの間では切れない）。改行の位置は探さない
 */
export function splitEscaped(body: string, max = SECTION_TEXT_MAX): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const ch of body) {
    const escaped = escapeSlack(ch);
    if (current.length + escaped.length > max) {
      chunks.push(current);
      current = "";
    }
    current += escaped;
  }
  if (current !== "" || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** ISO 8601 の時刻を「YYYY-MM-DD HH:mm（日本時間）」にする（Asia/Tokyo は夏時間がないので、9時間を足して読む） */
export function formatJst(iso: string): string {
  const d = new Date(Date.parse(iso) + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}（日本時間）`;
}

export type ContactMessageForSlack = {
  category: ContactCategory;
  /** 返信先。登録がなければ null */
  email: string | null;
  /** 受け付けた時刻（ISO 8601、UTC） */
  occurredAt: string;
  userId: string;
  /** 受付番号（outbox の行の id） */
  receiptId: string;
  /** 検証と正規化のあとの内容 */
  body: string;
};

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: false });

/** Incoming Webhook の JSON */
export function buildSlackMessage(m: ContactMessageForSlack) {
  const title = escapeSlack(`問い合わせ：${CONTACT_CATEGORY_LABELS[m.category]}`);
  return {
    text: title,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      { type: "header", text: plain(title) },
      {
        type: "section",
        fields: [
          plain(escapeSlack(`返信先：${m.email ?? "登録なし"}`)),
          plain(escapeSlack(`受付：${formatJst(m.occurredAt)}`)),
          plain(escapeSlack(`利用者ID：${m.userId}`)),
          plain(escapeSlack(`受付番号：${m.receiptId}`)),
        ],
      },
      ...splitEscaped(m.body).map((text) => ({ type: "section", text: plain(text) })),
    ],
  };
}
