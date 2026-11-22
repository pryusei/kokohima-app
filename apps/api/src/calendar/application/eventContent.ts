import type { MeetupForCalendar } from "../../invitation/application/calendarFacing";
import { getHistoryProfiles } from "../../identity/application/auth";
import type { Ctx } from "./connections";

// カレンダーに書く内容（docs/specs/T-06-calendar.md「書く内容」決定事項8）。Google と .ics で同じにする
// ひとことは書かない。タイトルは自分以外の（抜けていない）参加者の表示名

export const UNNAMED_FRIEND = "名前未設定の友達";
/** 退会した人（docs/specs/T-16-withdrawal.md） */
export const WITHDRAWN_USER = "退会したユーザー";

export async function eventContent(ctx: Ctx, meetup: MeetupForCalendar, forUserId: string) {
  const others = meetup.participants.filter((p) => !p.left && p.userId !== forUserId).map((p) => p.userId);
  const profiles = await getHistoryProfiles(ctx.env, others);
  const names = others.map((id) => {
    const p = profiles.get(id);
    return p?.withdrawn ? WITHDRAWN_USER : (p?.displayName ?? UNNAMED_FRIEND);
  });
  const title = names.length > 0 ? `ここ暇：${names.join("、")}` : "ここ暇";
  const description = [`${ctx.env.APP_ORIGIN}/meetups/${meetup.id}`, ...(meetup.url ? [meetup.url] : [])].join("\n");
  return { title, location: meetup.area ?? "", description };
}
