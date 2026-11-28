import { meetupForCalendar, type MeetupForCalendar } from "../../invitation/application/calendarFacing";
import { externalEventId, ReauthRequired } from "../domain/provider";
import * as repo from "../infra/repository";
import { accessTokenFor, providerFor, type Ctx } from "./connections";

// 前に「ここ暇」カレンダーに書いた予定の後始末（docs/specs/T-59-choose-calendar-add.md「振る舞い 4.」決めたこと3）。
// 成立した予定を Google に自動で書くのはやめた（本人が「Googleカレンダーに追加」で入れる）。
// 前に「ここ暇」カレンダーを作った人（calendar_id がある連携）について、キャンセル・抜けた予定を消すことだけを続ける。
// 書き込み・カレンダーの作成・タイトルの書き直しはしない。同じイベントが何度届いても結果は同じ

const shouldRemain = (m: MeetupForCalendar, userId: string) =>
  m.status === "confirmed" && m.participants.some((p) => p.userId === userId && !p.left);

/** 1人分：もう残すべきでない予定なら消す。カレンダーが使えなければ（上限以外の403）calendar_id を外す */
async function removeIfGone(ctx: Ctx, meetup: MeetupForCalendar, conn: repo.ConnectionRow) {
  const calendarId = conn.calendar_id;
  if (!calendarId || shouldRemain(meetup, conn.user_id)) return;
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(ctx, conn);
  } catch (e) {
    if (e instanceof ReauthRequired) return;
    throw e;
  }
  const result = await providerFor(ctx).deleteEvent(accessToken, calendarId, externalEventId(meetup.id));
  if (result === "calendar_missing") await repo.clearCalendarId(ctx.env.DB, conn.user_id, conn.provider, calendarId);
}

/** キャンセル・抜けた予定（MeetupCancelled・MeetupLeft）を、前に書いた参加者（抜けた人を含む）のカレンダーから消す */
export async function removeFromCalendars(ctx: Ctx, meetupId: string) {
  const meetup = await meetupForCalendar(ctx, meetupId);
  if (!meetup) return;
  const connections = await repo.activeConnectionsOf(
    ctx.env.DB,
    meetup.participants.map((p) => p.userId),
    "google",
  );
  for (const conn of connections) await removeIfGone(ctx, meetup, conn);
}
