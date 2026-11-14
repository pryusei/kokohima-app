import type { Interval } from "./busy";

// カレンダーのプロバイダの共通インターフェース（NF-06）。Google の実装は infra/google、Apple CalDAV は T-09 で足す
// 外部の形式（Google の JSON、iCalendar）はここに持ち込まず、「埋まり」「書き込む予定」に変換して渡す

/** 一時的な失敗（再試行してよい）。中身は持たない */
export class ProviderUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** 利用者が許可を取り消した（invalid_grant）。もう一度の連携が要る */
export class ReauthRequired extends Error {
  constructor() {
    super("reauth_required");
  }
}

/** 書き込む予定（アプリが作った「ここ暇」カレンダーに書く） */
export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  location: string;
  description: string;
  timezone: string;
};

export type GrantedTokens = { refreshToken: string; accessToken: string; scopes: string[] };

export interface CalendarProvider {
  /** 認可の画面の URL */
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** 認可コードをトークンに交換する */
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<GrantedTokens>;
  /** 更新用トークンでアクセストークンを取る */
  accessToken(refreshToken: string): Promise<string>;
  /** メインのカレンダーの [from, to) の埋まり */
  busy(accessToken: string, from: number, to: number): Promise<Interval[]>;
  createCalendar(accessToken: string, name: string, timezone: string): Promise<string>;
  deleteCalendar(accessToken: string, calendarId: string): Promise<void>;
  /** 書き込む（なければ作る、あれば更新する）。カレンダーが使えなければ "calendar_missing" */
  putEvent(accessToken: string, calendarId: string, event: CalendarEvent): Promise<"ok" | "calendar_missing">;
  /** 消す（もうなければ成功）。カレンダーが使えなければ "calendar_missing" */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<"ok" | "calendar_missing">;
  /** 失効させる（失敗しても投げない） */
  revoke(token: string): Promise<void>;
}

/** 予定のIDから決まる、プロバイダの予定のID（base32hex の 0-9a-v に収まる） */
export function externalEventId(meetupId: string): string {
  return `kh${meetupId.replace(/-/g, "").toLowerCase()}`;
}
