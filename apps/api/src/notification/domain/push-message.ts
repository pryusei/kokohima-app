import type { NotificationKind } from "./kinds";

// プッシュの本文（docs/specs/T-35-notification-visibility.md「プッシュの本文」）
// hidden（初期値）：種類だけ。detailed：相手の名前と開始の日時も。どちらでも、ひとこと・エリア・リンクは入れない。
// 断り・見送り・取り消し・抜けた（SILENT_KINDS）と新端末のログイン（メールだけ）はプッシュにしないので、文を持たない

export type LockScreen = "hidden" | "detailed";

/** 相手。表示名がなければ「名前未設定の友達」、退会した人は「退会したユーザー」（さんを付けない。T-16） */
export type PushActor = { displayName: string | null; withdrawn: boolean };

export type PushSource = {
  kind: NotificationKind;
  count: number | null;
  /** detailed のときだけ渡す。読めなければ null */
  actor: PushActor | null;
  /** detailed のときだけ渡す。誘い・募集・予定の開始（Unixミリ秒）。なければ null */
  startsAt: number | null;
};

const honorific = (a: PushActor) => (a.withdrawn ? "退会したユーザー" : `${a.displayName ?? "名前未設定の友達"}さん`);

/** 種類だけの文（hidden）と、名前つきの文（detailed）。名前つきの文がない種類は named を持たない */
const TEXT: Partial<Record<NotificationKind, { plain: string; named?: (name: string) => string }>> = {
  invite_received: { plain: "誘いが届きました", named: (n) => `${n}から誘いが届きました` },
  invite_countered: { plain: "別の時間の提案があります", named: (n) => `${n}から別の時間の提案があります` },
  broadcast_received: { plain: "募集が届きました", named: (n) => `${n}が募集しています` },
  broadcast_decided: { plain: "募集が決まりました！", named: (n) => `${n}の募集が決まりました！` },
  meetup_confirmed: { plain: "予定が成立しました！", named: (n) => `${n}と予定が成立しました！` },
  friend_added: { plain: "友達が増えました", named: (n) => `${n}と友達になりました` },
  calendar_reauth: { plain: "カレンダーの連携が切れました" },
};

/** 開始の日時（例：「11月28日(金) 19:00〜」）。利用者のタイムゾーンで */
export function formatStart(startsAt: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(startsAt));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}月${get("day")}日(${get("weekday")}) ${get("hour")}:${get("minute")}〜`;
}

/** ロック画面に出す本文。プッシュにしない種類は null */
export function pushBodyFor(source: PushSource, mode: LockScreen, timezone: string): string | null {
  if (source.kind === "availability_cancelled") {
    return `カレンダーの予定と重なったここ暇を${source.count ?? 1}件取り消しました`;
  }
  const text = TEXT[source.kind];
  if (!text) return null;
  if (mode === "hidden") return text.plain;
  const head = text.named && source.actor ? text.named(honorific(source.actor)) : text.plain;
  return source.startsAt === null ? head : `${head}\n${formatStart(source.startsAt, timezone)}`;
}

/** 本文に日時を出す種類と、読む対象（T-35）。counter は「この時間なら」の代わりの時間 */
export const SLOT_OF: Partial<Record<NotificationKind, "direct_invite" | "counter" | "broadcast" | "meetup">> = {
  invite_received: "direct_invite",
  invite_countered: "counter",
  broadcast_received: "broadcast",
  broadcast_decided: "broadcast",
  meetup_confirmed: "meetup",
};

/** Service Worker に渡す中身（暗号化して送る）。v は形の版、id は同じお知らせの再送を1つにまとめる tag に使う */
export const pushPayloadOf = (notificationId: string, body: string) => JSON.stringify({ v: 1, id: notificationId, body });
