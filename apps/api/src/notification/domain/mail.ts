import type { NotificationKind } from "./kinds";
import { DARK, LIGHT } from "./mail-theme";

// メールの文面（docs/specs/T-07-notification.md「メールの中身」決定事項6、docs/specs/T-23-rich-mail.md）
// 相手の名前・ひとこと・エリア・予定の時刻・ログイン用のリンクを入れない。HTML と、同じ内容のテキストを作る

type Summarized = Exclude<NotificationKind, "new_login">;
type Tone = "lamp" | "meet" | "quiet" | "action";

// 断り・取り消し・連携切れなどは、赤や警告の色を使わず quiet にする
const LOOK: Record<NotificationKind, { summary: string; emoji: string; tone: Tone }> = {
  invite_received: { summary: "誘いが届きました", emoji: "💌", tone: "lamp" },
  invite_declined: { summary: "誘いに返事がありました", emoji: "🌙", tone: "quiet" },
  invite_countered: { summary: "誘いに別の時間の提案がありました", emoji: "💬", tone: "lamp" },
  invite_skipped: { summary: "誘いが見送りになりました", emoji: "🌙", tone: "quiet" },
  broadcast_received: { summary: "募集が届きました", emoji: "📣", tone: "lamp" },
  broadcast_decided: { summary: "募集が決まりました", emoji: "🎉", tone: "meet" },
  meetup_confirmed: { summary: "予定が成立しました", emoji: "🎉", tone: "meet" },
  meetup_cancelled: { summary: "予定がなくなりました", emoji: "🌙", tone: "quiet" },
  meetup_left: { summary: "予定から1人抜けました", emoji: "🌙", tone: "quiet" },
  friend_added: { summary: "友達が増えました", emoji: "🙌", tone: "lamp" },
  availability_cancelled: { summary: "カレンダーの予定と重なったここ暇を取り消しました", emoji: "🌙", tone: "quiet" },
  calendar_reauth: { summary: "カレンダーの連携が切れました", emoji: "🌙", tone: "quiet" },
  new_login: { summary: "新しい端末でログインがありました", emoji: "🔔", tone: "action" },
};

const FOOTER = "通知はアプリの設定で止められます（新しい端末でのログインのお知らせは止められません）。";
const OPEN_APP = "アプリを開いて、お知らせを確認してください。";

export type Mail = { subject: string; text: string; html: string };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** href に入れてよい URL。https か、開発用の http://localhost だけ */
export function safeOrigin(origin: string): string | null {
  return /^(https:\/\/|http:\/\/localhost[:/]|http:\/\/localhost$)[^\s"'<>]*$/.test(origin) ? origin : null;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP',Meiryo,sans-serif";

function heroColors(tone: Tone) {
  switch (tone) {
    case "lamp":
      return { bg: LIGHT.lamp, ink: LIGHT["on-lamp"] };
    case "meet":
      return { bg: LIGHT.meet, ink: LIGHT["on-meet"] };
    case "action":
      return { bg: LIGHT.action, ink: LIGHT["on-action"] };
    default:
      return { bg: LIGHT["quiet-bg"], ink: LIGHT["quiet-ink"] };
  }
}

function heroDark(tone: Tone) {
  const key = { lamp: "lamp", meet: "meet", action: "action", quiet: "quiet-bg" }[tone] as "lamp";
  const on = { lamp: "on-lamp", meet: "on-meet", action: "on-action", quiet: "quiet-ink" }[tone] as "on-lamp";
  return { bg: DARK[key], ink: DARK[on] };
}

function buildHtml(args: {
  kind: NotificationKind;
  heading: string;
  preheader: string;
  body: string[];
  details: [string, string][];
  origin: string;
}): string {
  const { kind, heading, preheader, body, details, origin } = args;
  const look = LOOK[kind];
  const hero = heroColors(look.tone);
  const dark = heroDark(look.tone);
  const url = safeOrigin(origin);
  const e = escapeHtml;

  const paragraphs = body
    .map(
      (p, i) =>
        `<p class="${i === 0 ? "text-main" : "text-sub"}" style="margin:0 0 12px;font-size:${i === 0 ? 16 : 14}px;line-height:1.8;color:${i === 0 ? LIGHT.ink : LIGHT["ink-muted"]};">${e(p)}</p>`,
    )
    .join("\n");

  const detailRows = details.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="box-info" style="margin:8px 0 0;background:${LIGHT["surface-sunken"]};border-radius:12px;">
${details
  .map(
    ([k, v]) =>
      `<tr><td class="text-sub" style="padding:10px 16px;font-size:13px;color:${LIGHT["ink-muted"]};white-space:nowrap;">${e(k)}</td><td class="text-main" style="padding:10px 16px;font-size:14px;color:${LIGHT.ink};">${e(v)}</td></tr>`,
  )
  .join("\n")}
</table>`
    : "";

  const button = url
    ? `<tr>
<td align="center" class="px" style="padding:24px 40px 36px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${LIGHT.action}" class="btn" style="background:${LIGHT.action};border-radius:999px;">
<a href="${e(url)}" target="_blank" class="btn-link" style="display:inline-block;padding:16px 44px;font-family:${FONT};font-size:16px;font-weight:700;color:${LIGHT["on-action"]};border-radius:999px;">アプリを開く &rarr;</a>
</td></tr></table>
<div class="text-sub" style="margin-top:14px;font-family:${FONT};font-size:12px;color:${LIGHT["ink-muted"]};">ボタンが開けない場合：${e(url)}</div>
</td>
</tr>`
    : "";

  const footerLink = url ? `<br><a href="${e(url)}" style="color:${LIGHT["ink-muted"]};text-decoration:underline;">${e(url)}</a>` : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(heading)}</title>
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  a { text-decoration:none; }
  @media (max-width:620px) {
    .container { width:100% !important; }
    .px { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:22px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-page { background:${DARK.bg} !important; }
    .bg-card { background:${DARK.surface} !important; }
    .text-main { color:${DARK.ink} !important; }
    .text-sub { color:${DARK["ink-muted"]} !important; }
    .box-info { background:${DARK["surface-sunken"]} !important; }
    .divider { border-color:${DARK.line} !important; }
    .hero { background:${dark.bg} !important; }
    .hero-text { color:${dark.ink} !important; }
    .btn { background:${DARK.action} !important; }
    .btn-link { color:${DARK["on-action"]} !important; }
  }
</style>
</head>
<body class="bg-page" style="margin:0;padding:0;background:${LIGHT.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-page" style="background:${LIGHT.bg};">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
<tr><td align="center" style="padding:0 0 20px;font-family:${FONT};"><span class="text-main" style="font-size:22px;font-weight:800;letter-spacing:1px;color:${LIGHT.ink};">ここ暇</span></td></tr>
<tr><td class="bg-card" style="background:${LIGHT.surface};border-radius:20px;overflow:hidden;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" bgcolor="${hero.bg}" class="hero" style="background:${hero.bg};padding:40px 24px 32px;">
<div style="font-size:44px;line-height:1.2;">${look.emoji}</div>
<div class="h1 hero-text" style="margin:16px 0 0;font-family:${FONT};font-size:24px;line-height:1.4;font-weight:800;color:${hero.ink};">${e(heading)}</div>
<div class="hero-text" style="margin:8px 0 0;font-family:${FONT};font-size:14px;color:${hero.ink};">新しいお知らせが届いています</div>
</td></tr>
<tr><td class="px" style="padding:32px 40px 8px;font-family:${FONT};">
${paragraphs}
${detailRows}
</td></tr>
${button}
<tr><td class="px" style="padding:0 40px;"><div class="divider" style="border-top:1px solid ${LIGHT.line};font-size:0;line-height:0;">&nbsp;</div></td></tr>
<tr><td class="px" style="padding:24px 40px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="box-info text-sub" style="background:${LIGHT["surface-sunken"]};border-radius:12px;padding:16px 18px;font-family:${FONT};font-size:12.5px;line-height:1.8;color:${LIGHT["ink-muted"]};">${e(FOOTER)}</td>
</tr></table>
</td></tr>
</table>
</td></tr>
<tr><td align="center" class="text-sub" style="padding:24px 16px 0;font-family:${FONT};font-size:11px;line-height:1.8;color:${LIGHT["ink-muted"]};">このメールは「ここ暇」から自動送信されています。<br>心当たりがない場合は破棄してください。${footerLink}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

export function mailFor(
  n: { kind: NotificationKind; device: string | null; createdAt: number },
  app: { origin: string; timezone: string },
): Mail {
  if (n.kind === "new_login") {
    const when = new Intl.DateTimeFormat("ja-JP", {
      timeZone: app.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(n.createdAt));
    const device = n.device ?? "不明";
    const advice = "心当たりがない場合は、アプリを開いて「すべての端末からログアウト」を押してください。";
    return {
      subject: "ここ暇：新しい端末でログインがありました",
      text: [
        "新しい端末でログインがありました。",
        `端末：${device}`,
        `日時：${when}`,
        "",
        advice,
        app.origin,
        "",
        FOOTER,
      ].join("\n"),
      html: buildHtml({
        kind: n.kind,
        heading: LOOK.new_login.summary,
        preheader: "新しい端末でログインがありました。",
        body: ["新しい端末でログインがありました。", advice],
        details: [
          ["端末", device],
          ["日時", when],
        ],
        origin: app.origin,
      }),
    };
  }
  const summary = LOOK[n.kind as Summarized].summary;
  return {
    subject: "ここ暇：新しいお知らせがあります",
    text: [`${summary}。`, OPEN_APP, app.origin, "", FOOTER].join("\n"),
    html: buildHtml({
      kind: n.kind,
      heading: summary,
      preheader: `${summary}。アプリを開いて確認しましょう。`,
      body: [OPEN_APP, "くわしい内容はメールに載せていません。アプリで確認できます。"],
      details: [],
      origin: app.origin,
    }),
  };
}
