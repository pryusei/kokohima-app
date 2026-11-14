import { calendarConnectionsSchema, freeSlotsSchema, icsLinkSchema } from "@kokohima/shared";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { rangeFrom } from "../availability/format";

// カレンダー連携の取得（docs/specs/T-06-calendar.md「画面」。data-fetching スキル：キーは keys.ts の工場から）

export const connectionsQuery = () => ({
  queryKey: keys.calendar.connections(),
  queryFn: () => apiGet("/api/v1/calendar/connections", calendarConnectionsSchema),
});

/** 今日から7日分の候補 */
export const freeSlotsQuery = (date: string) => ({
  queryKey: keys.availability.calendarFree(date),
  queryFn: () => {
    const range = rangeFrom(date, 7);
    return apiGet(
      `/api/v1/calendar/free-slots?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      freeSlotsSchema,
    );
  },
});

/** .ics の一時的な URL を発行する（5分。Bearer が要るので、リンクにせず発行してから画面遷移する） */
export const createIcsLink = (meetupId: string) =>
  apiSend("POST", `/api/v1/meetups/${encodeURIComponent(meetupId)}/ics-links`, undefined, icsLinkSchema);
