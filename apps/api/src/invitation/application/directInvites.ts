import type {
  CreateDirectInviteRequest,
  DirectInvite,
  Meetup,
  PublicProfile,
  RespondDirectInviteRequest,
} from "@kokohima/shared";
import { visibleSlotsFor } from "../../availability/application/availability";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles } from "../../identity/application/auth";
import type { Cursor } from "../../shared/cursor";
import {
  cancelError,
  checkInviteTime,
  DAILY_SEND_LIMIT,
  decideError,
  effectiveStatus,
  expiresAtFor,
  isSameRange,
  kindFor,
  respondError,
  retryAfterSeconds,
  SEND_WINDOW_MS,
  type TransitionError,
} from "../domain/directInvite";
import * as repo from "../infra/repository";

// 個別の誘いのユースケース（docs/specs/T-04-direct-invite.md「振る舞い」）
// 閲覧者IDは呼び出し側（requireAuth）から受け取り、body・query のユーザーIDは閲覧者として使わない

type Ctx = { env: Bindings; deps: AppDeps };

const iso = (ms: number) => new Date(ms).toISOString();

/** 退会などで公開プロフィールが読めない相手（今は利用者の削除で誘いも消えるので、通常は起きない） */
const unknownProfile = (id: string): PublicProfile => ({ id, displayName: null, avatarUrl: null });

/** outbox のイベント。payload は ID と occurredAt だけ（ひとこと・エリア・URL・時刻は入れない） */
const event = (type: string, payload: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  type,
  payload: JSON.stringify(payload),
});

function toInviteDto(row: repo.InviteRow, viewerId: string, profiles: Map<string, PublicProfile>, now: number): DirectInvite {
  const received = row.recipient_id === viewerId;
  const counterpartId = received ? row.sender_id : row.recipient_id;
  return {
    id: row.id,
    kind: row.kind,
    direction: received ? "received" : "sent",
    counterpart: profiles.get(counterpartId) ?? unknownProfile(counterpartId),
    status: effectiveStatus(
      { status: row.status, expiresAt: row.expires_at, counterStartsAt: row.counter_starts_at },
      now,
    ),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    area: row.area,
    message: row.message,
    url: row.url,
    expiresAt: iso(row.expires_at),
    counterProposal:
      row.counter_starts_at !== null && row.counter_ends_at !== null
        ? { startsAt: iso(row.counter_starts_at), endsAt: iso(row.counter_ends_at) }
        : null,
    meetupId: row.meetup_id,
    createdAt: iso(row.created_at),
  };
}

async function inviteDtos(ctx: Ctx, viewerId: string, rows: repo.InviteRow[]) {
  // 渡すのは、閲覧者が参加者として SQL で絞った誘いの相手のIDだけ
  const ids = [...new Set(rows.map((r) => (r.recipient_id === viewerId ? r.sender_id : r.recipient_id)))];
  const profiles = await getPublicProfiles(ctx.env, ids);
  const now = ctx.deps.now();
  return rows.map((r) => toInviteDto(r, viewerId, profiles, now));
}

async function reloadInvite(ctx: Ctx, viewerId: string, id: string) {
  const row = await repo.findInviteFor(ctx.env.DB, viewerId, id);
  if (!row) return null;
  const [dto] = await inviteDtos(ctx, viewerId, [row]);
  return dto ?? null;
}

// ---- 送信 ----

export type SendResult =
  | { kind: "created"; invite: DirectInvite }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "duplicate" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export async function sendInvite(ctx: Ctx, viewerId: string, input: CreateDirectInviteRequest): Promise<SendResult> {
  const now = ctx.deps.now();
  const startsAt = Date.parse(input.startsAt);
  const endsAt = Date.parse(input.endsAt);
  if (checkInviteTime(startsAt, endsAt, now)) return { kind: "invalid" };

  // 友達でなければ（存在しない・自分・片方向を含む）ここで404。見えている枠だけで「あそぼ」を決める
  const visible = await visibleSlotsFor(ctx, viewerId, input.recipientId, { from: startsAt, to: endsAt });
  if (!visible) return { kind: "not_found" };

  const row: repo.NewInvite = {
    id: crypto.randomUUID(),
    senderId: viewerId,
    recipientId: input.recipientId,
    kind: kindFor(visible, { startsAt, endsAt }),
    startsAt,
    endsAt,
    area: input.area,
    message: input.message,
    url: input.url,
    expiresAt: expiresAtFor(input.expiresIn, startsAt, now),
    now,
  };
  const since = now - SEND_WINDOW_MS;
  const sent = event("DirectInviteSent", {
    userId: input.recipientId,
    inviteId: row.id,
    actorId: viewerId,
    occurredAt: iso(now),
  });

  const outcome = await attemptSend(
    () => repo.insertInvite(ctx.env.DB, row, { count: DAILY_SEND_LIMIT, since }, sent),
    () => repo.diagnoseSend(ctx.env.DB, row, since),
    now,
  );
  if (outcome.kind !== "inserted") return outcome;
  const invite = await reloadInvite(ctx, viewerId, row.id);
  return invite ? { kind: "created", invite } : { kind: "not_found" };
}

type Diagnosis = { friends: boolean; duplicate: boolean; sent: number; oldest: number | null };
type AttemptOutcome =
  | { kind: "inserted" }
  | { kind: "not_found" }
  | { kind: "duplicate" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/**
 * 追加が0行なら、判定の順番（404 → 409 → 429）で理由を読み直す。読み直してもどの条件にも当てはまらない
 * （その間に同じ誘いの期限が切れた・古い送信が24時間を過ぎた）ときは1回だけやり直し、だめなら409
 */
export async function attemptSend(
  insert: () => Promise<boolean>,
  diagnose: () => Promise<Diagnosis>,
  now: number,
): Promise<AttemptOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await insert()) return { kind: "inserted" };
    const why = await diagnose();
    if (!why.friends) return { kind: "not_found" };
    if (why.duplicate) return { kind: "duplicate" };
    if (why.sent >= DAILY_SEND_LIMIT && why.oldest !== null) {
      return { kind: "rate_limited", retryAfterSeconds: retryAfterSeconds(why.oldest, now) };
    }
  }
  return { kind: "duplicate" };
}

// ---- 取得 ----

export async function getInvite(ctx: Ctx, viewerId: string, id: string) {
  return reloadInvite(ctx, viewerId, id);
}

export async function listInvites(
  ctx: Ctx,
  viewerId: string,
  box: "received" | "sent",
  limit: number,
  cursor: Cursor | null,
) {
  const rows = await repo.listInvites(ctx.env.DB, viewerId, box, limit, cursor);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await inviteDtos(ctx, viewerId, page),
    nextCursor: rows.length > limit && last ? { k: last.created_at, id: last.id } : null,
  };
}

// ---- 返答・決定 ----

export type TransitionResult =
  | { kind: "ok"; invite: DirectInvite }
  | { kind: "not_found" }
  | { kind: "invalid" }
  | { kind: "conflict"; reason: TransitionError };

const ref = (row: repo.InviteRow) => ({ id: row.id, senderId: row.sender_id, recipientId: row.recipient_id });
const times = (row: repo.InviteRow) => ({
  status: row.status,
  expiresAt: row.expires_at,
  counterStartsAt: row.counter_starts_at,
});

/** 遷移が0行だったときの理由を、保存した状態で決める */
async function failure(
  ctx: Ctx,
  viewerId: string,
  id: string,
  check: (row: repo.InviteRow, now: number) => TransitionError | null,
): Promise<TransitionResult> {
  const row = await repo.findInviteFor(ctx.env.DB, viewerId, id);
  if (!row) return { kind: "not_found" };
  return { kind: "conflict", reason: check(row, ctx.deps.now()) ?? "invalid_state" };
}

async function done(ctx: Ctx, viewerId: string, id: string): Promise<TransitionResult> {
  const invite = await reloadInvite(ctx, viewerId, id);
  return invite ? { kind: "ok", invite } : { kind: "not_found" };
}

export async function respond(
  ctx: Ctx,
  viewerId: string,
  id: string,
  input: RespondDirectInviteRequest,
): Promise<TransitionResult> {
  const row = await repo.findInviteFor(ctx.env.DB, viewerId, id);
  // 返答できるのは受信者だけ。送信者・参加者でない人には、存在しない場合と同じ404
  if (!row || row.recipient_id !== viewerId) return { kind: "not_found" };
  const now = ctx.deps.now();
  const recheck = (r: repo.InviteRow, t: number) => respondError(times(r), t);

  if (input.response === "accept") {
    const meetupId = crypto.randomUUID();
    const confirmed = event("MeetupConfirmed", {
      meetupId,
      inviteId: row.id,
      participantIds: [row.sender_id, row.recipient_id],
      occurredAt: iso(now),
    });
    const ok = await repo.acceptInvite(
      ctx.env.DB,
      { ...ref(row), startsAt: row.starts_at, endsAt: row.ends_at },
      meetupId,
      confirmed,
      now,
    );
    return ok ? done(ctx, viewerId, id) : failure(ctx, viewerId, id, recheck);
  }

  if (input.response === "decline") {
    const declined = event("DirectInviteDeclined", {
      userId: row.sender_id,
      inviteId: row.id,
      actorId: viewerId,
      occurredAt: iso(now),
    });
    const ok = await repo.respondInvite(ctx.env.DB, ref(row), { status: "declined" }, declined, now);
    return ok ? done(ctx, viewerId, id) : failure(ctx, viewerId, id, recheck);
  }

  const counter = { startsAt: Date.parse(input.startsAt), endsAt: Date.parse(input.endsAt) };
  if (checkInviteTime(counter.startsAt, counter.endsAt, now)) return { kind: "invalid" };
  if (isSameRange(counter, { startsAt: row.starts_at, endsAt: row.ends_at })) return { kind: "invalid" };
  const proposed = event("DirectInviteCounterProposed", {
    userId: row.sender_id,
    inviteId: row.id,
    actorId: viewerId,
    occurredAt: iso(now),
  });
  const ok = await repo.respondInvite(
    ctx.env.DB,
    ref(row),
    { status: "counter_proposed", ...counter },
    proposed,
    now,
  );
  return ok ? done(ctx, viewerId, id) : failure(ctx, viewerId, id, recheck);
}

export async function decide(
  ctx: Ctx,
  viewerId: string,
  id: string,
  decision: "accept" | "skip",
): Promise<TransitionResult> {
  const row = await repo.findInviteFor(ctx.env.DB, viewerId, id);
  // 決められるのは送信者だけ
  if (!row || row.sender_id !== viewerId) return { kind: "not_found" };
  const now = ctx.deps.now();
  const recheck = (r: repo.InviteRow, t: number) => decideError(times(r), t);

  if (decision === "skip") {
    const skipped = event("DirectInviteSkipped", {
      userId: row.recipient_id,
      inviteId: row.id,
      actorId: viewerId,
      occurredAt: iso(now),
    });
    const ok = await repo.decideSkip(ctx.env.DB, ref(row), skipped, now);
    return ok ? done(ctx, viewerId, id) : failure(ctx, viewerId, id, recheck);
  }

  // counter_proposed でなければ代わりの時間がない。状態の判定は failure で行う
  if (row.counter_starts_at === null || row.counter_ends_at === null) return failure(ctx, viewerId, id, recheck);
  const meetupId = crypto.randomUUID();
  const confirmed = event("MeetupConfirmed", {
    meetupId,
    inviteId: row.id,
    participantIds: [row.sender_id, row.recipient_id],
    occurredAt: iso(now),
  });
  const ok = await repo.decideAccept(
    ctx.env.DB,
    { ...ref(row), counterStartsAt: row.counter_starts_at, counterEndsAt: row.counter_ends_at },
    meetupId,
    confirmed,
    now,
  );
  return ok ? done(ctx, viewerId, id) : failure(ctx, viewerId, id, recheck);
}

// ---- 成立した予定 ----

async function meetupDtos(ctx: Ctx, viewerId: string, rows: repo.MeetupRow[]): Promise<Meetup[]> {
  const participants = await repo.participantsOf(
    ctx.env.DB,
    rows.map((r) => r.id),
  );
  // 渡すのは、閲覧者が参加者として SQL で絞った予定の参加者のIDだけ
  const others = new Set([...participants.values()].flat().filter((id) => id !== viewerId));
  const profiles = await getPublicProfiles(ctx.env, [...others]);
  return rows.map((r) => ({
    id: r.id,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    status: r.status,
    participants: (participants.get(r.id) ?? [])
      .filter((id) => id !== viewerId)
      .map((id) => profiles.get(id) ?? unknownProfile(id)),
    area: r.area,
    message: r.message,
    url: r.url,
    directInviteId: r.direct_invite_id,
    createdAt: iso(r.created_at),
  }));
}

export async function getMeetup(ctx: Ctx, viewerId: string, id: string) {
  const row = await repo.findMeetupFor(ctx.env.DB, viewerId, id);
  if (!row) return null;
  const [dto] = await meetupDtos(ctx, viewerId, [row]);
  return dto ?? null;
}

export async function listMeetups(ctx: Ctx, viewerId: string, limit: number, cursor: Cursor | null) {
  const rows = await repo.listMeetups(ctx.env.DB, viewerId, ctx.deps.now(), limit, cursor);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await meetupDtos(ctx, viewerId, page),
    nextCursor: rows.length > limit && last ? { k: last.starts_at, id: last.id } : null,
  };
}

export type CancelResult =
  | { kind: "ok"; meetup: Meetup }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: TransitionError };

export async function cancelMeetup(ctx: Ctx, viewerId: string, id: string): Promise<CancelResult> {
  const row = await repo.findMeetupFor(ctx.env.DB, viewerId, id);
  if (!row) return { kind: "not_found" };
  const now = ctx.deps.now();
  const participants = (await repo.participantsOf(ctx.env.DB, [id])).get(id) ?? [];
  const cancelled = event("MeetupCancelled", { meetupId: id, actorId: viewerId, participantIds: participants, occurredAt: iso(now) });
  if (await repo.cancelMeetup(ctx.env.DB, viewerId, id, cancelled, now)) {
    const meetup = await getMeetup(ctx, viewerId, id);
    return meetup ? { kind: "ok", meetup } : { kind: "not_found" };
  }
  const latest = await repo.findMeetupFor(ctx.env.DB, viewerId, id);
  if (!latest) return { kind: "not_found" };
  return {
    kind: "conflict",
    reason: cancelError({ status: latest.status, startsAt: latest.starts_at }, ctx.deps.now()) ?? "invalid_state",
  };
}
