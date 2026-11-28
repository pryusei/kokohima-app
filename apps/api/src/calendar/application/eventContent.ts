import { calendarEventDescription, calendarEventTitle, UNNAMED_FRIEND, WITHDRAWN_USER } from "@kokohima/shared";
import type { MeetupForCalendar } from "../../invitation/application/calendarFacing";
import { getHistoryNames } from "../../identity/application/auth";
import type { Ctx } from "./connections";

// カレンダーに書く内容（docs/specs/T-06-calendar.md「書く内容」決定事項8）。.ics と、画面の Google カレンダーの追加画面の URL
// （packages/shared の googleCalendarAddUrl。T-59）で同じにする。ひとことは書かない。タイトルは自分以外の（抜けていない）参加者の表示名

export async function eventContent(ctx: Ctx, meetup: MeetupForCalendar, forUserId: string) {
  const others = meetup.participants.filter((p) => !p.left && p.userId !== forUserId).map((p) => p.userId);
  const profiles = await getHistoryNames(ctx, forUserId, others);
  const names = others.map((id) => {
    const p = profiles.get(id);
    return p?.withdrawn ? WITHDRAWN_USER : (p?.displayName ?? UNNAMED_FRIEND);
  });
  return {
    title: calendarEventTitle(names),
    location: meetup.area ?? "",
    description: calendarEventDescription(ctx.env.APP_ORIGIN, meetup.id, meetup.url),
  };
}
