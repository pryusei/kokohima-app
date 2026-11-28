import type { Meetup } from "./schemas/invitation";

// 成立した予定をカレンダーに入れるときの中身（docs/specs/T-59-choose-calendar-add.md「振る舞い 2.」、T-06「書く内容」）。
// Google カレンダーの追加画面の URL（画面）と .ics（api）で同じにする。ひとことは入れない

/** 表示名がない人（T-02） */
export const UNNAMED_FRIEND = "名前未設定の友達";
/** 退会した人（docs/specs/T-16-withdrawal.md） */
export const WITHDRAWN_USER = "退会したユーザー";

/** カレンダーの予定のタイトル。names は自分以外の、抜けていない参加者の名前 */
export function calendarEventTitle(names: string[]): string {
  return names.length > 0 ? `ここ暇：${names.join("、")}` : "ここ暇";
}

/** 予定の説明：アプリの予定の画面の URL と、誘いのリンク（あれば） */
export function calendarEventDescription(origin: string, meetupId: string, url: string | null): string {
  return [`${origin}/meetups/${meetupId}`, ...(url ? [url] : [])].join("\n");
}

const GOOGLE_CALENDAR_ADD = "https://calendar.google.com/calendar/render";

/** UTC の YYYYMMDDTHHMMSSZ */
const utcStamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * Google カレンダーの追加画面の URL。予定の参加者は、閲覧者自身と抜けた人を除いた形で API（GET /meetups/{id}）から届くので、そのまま使う。
 * 値はすべて encodeURIComponent で符号化する（利用者が入れた & = # 改行で別の引数を作れない）。
 * packages/shared は DOM の型を持たないので、URLSearchParams ではなく自分で組み立てる
 */
export function googleCalendarAddUrl(meetup: Meetup, origin: string): string {
  const names = meetup.participants.map((p) => (p.withdrawn ? WITHDRAWN_USER : (p.displayName ?? UNNAMED_FRIEND)));
  const params: [string, string][] = [
    ["action", "TEMPLATE"],
    ["text", calendarEventTitle(names)],
    ["dates", `${utcStamp(meetup.startsAt)}/${utcStamp(meetup.endsAt)}`],
    ["details", calendarEventDescription(origin, meetup.id, meetup.url)],
  ];
  if (meetup.area) params.push(["location", meetup.area]);
  return `${GOOGLE_CALENDAR_ADD}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
