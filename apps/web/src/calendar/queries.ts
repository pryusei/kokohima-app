import { calendarConnectionsSchema, freeSlotsSchema, icsLinkSchema } from "@kokohima/shared";
import { ApiError, apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { rangeFrom } from "../availability/format";

// カレンダー連携の取得（docs/specs/T-06-calendar.md「画面」。data-fetching スキル：キーは keys.ts の工場から）

export const connectionsQuery = () => ({
  queryKey: keys.calendar.connections(),
  queryFn: () => apiGet("/api/v1/calendar/connections", calendarConnectionsSchema),
});

/** 今日から14日分の候補（ここ暇タブの週の帯の点。docs/specs/T-55-availability-week-grid.md） */
export const freeSlotsQuery = (date: string) => ({
  queryKey: keys.availability.calendarFree(date),
  // 回数の上限（429。T-10）のあとは取り直さない（取り直すとさらに上限を使う）
  retry: (count: number, error: unknown) => !(error instanceof ApiError && error.status === 429) && count < 3,
  queryFn: () => {
    const range = rangeFrom(date, 14);
    return apiGet(
      `/api/v1/calendar/free-slots?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      freeSlotsSchema,
    );
  },
});

/** .ics の一時的な URL を発行する（5分。Bearer が要るので、リンクにせず発行してから画面遷移する） */
export const createIcsLink = (meetupId: string) =>
  apiSend("POST", `/api/v1/meetups/${encodeURIComponent(meetupId)}/ics-links`, undefined, icsLinkSchema);
