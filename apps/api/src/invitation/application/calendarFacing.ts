import { viewersWhoCanSee } from "../../availability/application/sharing";
import type { AppDeps, Bindings } from "../../env";
import * as repo from "../infra/repository";

// カレンダー連携（T-06）から使う invitation のユースケース。calendar は invitation の表を直接読まず、ここを通す

type Ctx = { env: Bindings; deps: AppDeps };

export type MeetupForCalendar = {
  id: string;
  status: "confirmed" | "cancelled";
  startsAt: number;
  endsAt: number;
  area: string | null;
  url: string | null;
  /** 抜けた人を含む */
  participants: { userId: string; left: boolean }[];
};

/** consumer が payload の予定を読む（閲覧者がいない処理。書き込みの対象は返した参加者に限る） */
export async function meetupForCalendar(ctx: Ctx, meetupId: string): Promise<MeetupForCalendar | null> {
  const row = await repo.findMeetupById(ctx.env.DB, meetupId);
  if (!row) return null;
  const participants = await repo.allParticipantsOf(ctx.env.DB, meetupId);
  return {
    id: row.id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    area: row.area,
    url: row.url,
    participants: participants.map((p) => ({ userId: p.user_id, left: p.left_at !== null })),
  };
}

/** LinkAttached の誘い・募集のリンク（閲覧者がいない処理。T-08）。行がない・リンクがなければ null */
export function linkOfSubject(ctx: Ctx, subject: { type: "direct_invite" | "broadcast"; id: string }) {
  return repo.linkOf(ctx.env.DB, subject);
}

/** 閲覧者が抜けていない参加者の予定（.ics）。それ以外は null */
export async function meetupForActiveParticipant(ctx: Ctx, viewerId: string, meetupId: string) {
  const row = await repo.findMeetupForActiveParticipant(ctx.env.DB, viewerId, meetupId);
  if (!row) return null;
  const participants = await repo.allParticipantsOf(ctx.env.DB, meetupId);
  return {
    id: row.id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    area: row.area,
    url: row.url,
    participants: participants.map((p) => ({ userId: p.user_id, left: p.left_at !== null })),
  } satisfies MeetupForCalendar;
}

/**
 * ここ暇の自動取り消し（AvailabilityCancelledByCalendar）を受けて、その枠への未返答の誘いを「今回は難しい」にする。
 * 手で断ったときと同じ遷移・同じイベントにし、自動で断ったことを区別させない（docs/specs/T-06-calendar.md）
 */
export async function declineForCancelledAvailability(
  ctx: Ctx,
  input: { userId: string; ranges: { startsAt: number; endsAt: number }[]; occurredAt: number },
) {
  if (input.ranges.length === 0) return 0;
  const now = ctx.deps.now();
  const rows = await repo.pendingInvitesOverlapping(ctx.env.DB, input.userId, input.ranges, input.occurredAt, now);
  // 受信者のここ暇を、取り消しの時点から今までずっと見られた送信者の誘いだけを断る（T-06 決定事項15）。
  // 「見せない」にした相手などの誘いは pending のまま残し、ここ暇がなかったときと同じに見せる
  const visible = await viewersWhoCanSee(
    ctx.env.DB,
    input.userId,
    rows.map((r) => r.sender_id),
    input.occurredAt,
  );
  let declined = 0;
  for (const row of rows) {
    if (!visible.has(row.sender_id)) continue;
    const event = {
      id: crypto.randomUUID(),
      type: "DirectInviteDeclined",
      payload: JSON.stringify({
        userId: row.sender_id,
        inviteId: row.id,
        actorId: row.recipient_id,
        occurredAt: new Date(now).toISOString(),
      }),
    };
    const ref = { id: row.id, senderId: row.sender_id, recipientId: row.recipient_id };
    if (await repo.respondInvite(ctx.env.DB, ref, { status: "declined" }, event, now)) declined++;
  }
  return declined;
}

// ---- 通知（T-07）から使う ----

export const broadcastOwnerOf = (ctx: Ctx, broadcastId: string) => repo.findBroadcastOwner(ctx.env.DB, broadcastId);
export const inviteActorOf = (ctx: Ctx, inviteId: string) => repo.findInviteActor(ctx.env.DB, inviteId);
/** お知らせのプッシュに出す日時（開始。T-35）。閲覧者で絞らない：受け取り手が決まったお知らせの対象の ID だけを渡すこと */
export const slotStartOf = (
  ctx: Ctx,
  subject: { type: "direct_invite" | "counter" | "broadcast" | "meetup"; id: string },
) => repo.findSlotStart(ctx.env.DB, subject);
