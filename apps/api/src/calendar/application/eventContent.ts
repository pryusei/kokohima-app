import type { MeetupForCalendar } from "../../invitation/application/calendarFacing";
import { getPublicProfiles } from "../../identity/application/auth";
import type { Ctx } from "./connections";

// カレンダーに書く内容（docs/specs/T-06-calendar.md「書く内容」決定事項8）。Google と .ics で同じにする
// ひとことは書かない。タイトルは自分以外の（抜けていない）参加者の表示名

export const UNNAMED_FRIEND = "名前未設定の友達";

export async function eventContent(ctx: Ctx, meetup: MeetupForCalendar, forUserId: string) {
  const others = meetup.participants.filter((p) => !p.left && p.userId !== forUserId).map((p) => p.userId);
  const profiles = await getPublicProfiles(ctx.env, others);
  const names = others.map((id) => profiles.get(id)?.displayName ?? UNNAMED_FRIEND);
  const title = names.length > 0 ? `ここ暇：${names.join("、")}` : "ここ暇";
  const description = [`${ctx.env.APP_ORIGIN}/meetups/${meetup.id}`, ...(meetup.url ? [meetup.url] : [])].join("\n");
  return { title, location: meetup.area ?? "", description };
}
