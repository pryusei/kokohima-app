import type { NotificationKind } from "./kinds";

// メールの文面（docs/specs/T-07-notification.md「メールの中身」決定事項6）
// 相手の名前・ひとこと・エリア・予定の時刻・ログイン用のリンクを入れない。テキストだけ

const SUMMARY: Record<Exclude<NotificationKind, "new_login">, string> = {
  invite_received: "誘いが届きました",
  invite_declined: "誘いに返事がありました",
  invite_countered: "誘いに別の時間の提案がありました",
  invite_skipped: "誘いが見送りになりました",
  broadcast_received: "募集が届きました",
  broadcast_decided: "募集が決まりました",
  meetup_confirmed: "予定が成立しました",
  meetup_cancelled: "予定がなくなりました",
  meetup_left: "予定から1人抜けました",
  friend_added: "友達が増えました",
  availability_cancelled: "カレンダーの予定と重なったここ暇を取り消しました",
  calendar_reauth: "カレンダーの連携が切れました",
};

const FOOTER = "通知はアプリの設定で止められます（新しい端末でのログインのお知らせは止められません）。";

export type Mail = { subject: string; text: string };

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
    return {
      subject: "ここ暇：新しい端末でログインがありました",
      text: [
        "新しい端末でログインがありました。",
        `端末：${n.device ?? "不明"}`,
        `日時：${when}`,
        "",
        "心当たりがない場合は、アプリを開いて「すべての端末からログアウト」を押してください。",
        app.origin,
        "",
        FOOTER,
      ].join("\n"),
    };
  }
  return {
    subject: "ここ暇：新しいお知らせがあります",
    text: [`${SUMMARY[n.kind]}。`, "アプリを開いて、お知らせを確認してください。", app.origin, "", FOOTER].join("\n"),
  };
}
