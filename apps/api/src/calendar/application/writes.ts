import { getUserTimezone } from "../../identity/application/auth";
import {
  meetupForCalendar,
  upcomingMeetupIdsOf,
  type MeetupForCalendar,
} from "../../invitation/application/calendarFacing";
import { externalEventId, ReauthRequired } from "../domain/provider";
import * as repo from "../infra/repository";
import { accessTokenFor, providerFor, type Ctx } from "./connections";
import { eventContent } from "./eventContent";

// 成立した予定の Google カレンダーへの書き込み（docs/specs/T-06-calendar.md「成立した予定のGoogleカレンダーへの書き込み」）
// 予定ごとに「あるべき状態」にそろえる。同じイベントが何度届いても、順番が入れ替わっても結果が同じになる

export const CALENDAR_NAME = "ここ暇";
export const UPCOMING_PAGE = 100;

const shouldExist = (m: MeetupForCalendar, userId: string, now: number) =>
  m.status === "confirmed" && m.endsAt > now && m.participants.some((p) => p.userId === userId && !p.left);

/** 「ここ暇」カレンダーの ID。なければ作る。同時に作られていたら、作った方を消して保存されている方を使う */
async function ensureCalendar(ctx: Ctx, conn: repo.ConnectionRow, accessToken: string): Promise<string | null> {
  if (conn.calendar_id) return conn.calendar_id;
  const provider = providerFor(ctx);
  const created = await provider.createCalendar(accessToken, CALENDAR_NAME, await getUserTimezone(ctx.env, conn.user_id));
  if (await repo.setCalendarIdIfEmpty(ctx.env.DB, conn.user_id, conn.provider, created)) return created;
  await provider.deleteCalendar(accessToken, created);
  return (await repo.findConnection(ctx.env.DB, conn.user_id, conn.provider))?.calendar_id ?? null;
}

/** カレンダーが使えなかった（利用者が消した・別のアカウント）。外して、これからの予定を書き直す */
async function recreateCalendar(ctx: Ctx, conn: repo.ConnectionRow, calendarId: string) {
  await repo.clearCalendarId(ctx.env.DB, conn.user_id, conn.provider, calendarId);
  await ctx.env.JOBS.send({
    kind: "outbox",
    id: crypto.randomUUID(),
    type: "CalendarConnected",
    payload: JSON.stringify({ userId: conn.user_id, provider: conn.provider, occurredAt: new Date(ctx.deps.now()).toISOString() }),
  });
}

/** 1人分をそろえる。書いた後に読み直し、書くべきでなくなっていたら消す（同時に届いたキャンセルとの入れ違い） */
async function reconcileFor(ctx: Ctx, meetup: MeetupForCalendar, conn: repo.ConnectionRow) {
  let accessToken: string;
  try {
    accessToken = await accessTokenFor(ctx, conn);
  } catch (e) {
    if (e instanceof ReauthRequired) return;
    throw e;
  }
  const provider = providerFor(ctx);
  const eventId = externalEventId(meetup.id);
  const now = ctx.deps.now();

  if (!shouldExist(meetup, conn.user_id, now)) {
    if (!conn.calendar_id) return;
    await provider.deleteEvent(accessToken, conn.calendar_id, eventId);
    return;
  }

  const calendarId = await ensureCalendar(ctx, conn, accessToken);
  if (!calendarId) return;
  const content = await eventContent(ctx, meetup, conn.user_id);
  const result = await provider.putEvent(accessToken, calendarId, {
    id: eventId,
    ...content,
    startsAt: meetup.startsAt,
    endsAt: meetup.endsAt,
    timezone: await getUserTimezone(ctx.env, conn.user_id),
  });
  if (result === "calendar_missing") {
    await recreateCalendar(ctx, conn, calendarId);
    return;
  }

  const latest = await meetupForCalendar(ctx, meetup.id);
  if (!latest || !shouldExist(latest, conn.user_id, ctx.deps.now())) {
    await provider.deleteEvent(accessToken, calendarId, eventId);
  }
}

/** 予定の参加者（抜けた人を含む。onlyUserId を渡すとその人だけ）のうち、連携が active の人をそろえる */
export async function reconcileMeetup(ctx: Ctx, meetupId: string, onlyUserId?: string) {
  const meetup = await meetupForCalendar(ctx, meetupId);
  if (!meetup) return;
  const userIds = meetup.participants.map((p) => p.userId).filter((id) => !onlyUserId || id === onlyUserId);
  const connections = await repo.activeConnectionsOf(ctx.env.DB, userIds, "google");
  for (const conn of connections) await reconcileFor(ctx, meetup, conn);
}

/** 連携した（し直した）人の、これからの予定を書き直す。100件ずつ、続きは Queue に送り直す */
export async function reconcileUpcomingOf(ctx: Ctx, userId: string, after = "") {
  const ids = await upcomingMeetupIdsOf(ctx, userId, UPCOMING_PAGE, after);
  for (const id of ids) await reconcileMeetup(ctx, id, userId);
  const last = ids.at(-1);
  if (ids.length === UPCOMING_PAGE && last) {
    await ctx.env.JOBS.send({
      kind: "outbox",
      id: crypto.randomUUID(),
      type: "CalendarConnected",
      payload: JSON.stringify({ userId, provider: "google", after: last, occurredAt: new Date(ctx.deps.now()).toISOString() }),
    });
  }
}
