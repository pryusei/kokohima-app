import type { Broadcast, CreateBroadcastRequest, PublicProfile } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles } from "../../identity/application/auth";
import type { Cursor } from "../../shared/cursor";
import { decideError, ownerResponseCount, respondError, viewerStatus } from "../domain/broadcast";
import {
  checkInviteTime,
  DAILY_SEND_LIMIT,
  expiresAtFor,
  SEND_WINDOW_MS,
  type TransitionError,
} from "../domain/directInvite";
import * as repo from "../infra/broadcastRepository";
import { attemptSend } from "./directInvites";

// 募集のユースケース（docs/specs/T-05-broadcast.md「振る舞い」）
// 閲覧者IDは呼び出し側（requireAuth）から受け取る。応じた人の名前・ID はどの応答にも入れない

type Ctx = { env: Bindings; deps: AppDeps };

const iso = (ms: number) => new Date(ms).toISOString();
const unknownProfile = (id: string): PublicProfile => ({ id, displayName: null, avatarUrl: null });

/**
 * 閲覧者から見た募集。募集者には人数と宛先を、宛先の人には自分の応答だけを返す。参加者でない宛先の人に返す値は、
 * ほかの人の応答と決定で変わらない（決定事項6）
 */
function toDto(
  row: repo.BroadcastRow,
  viewerId: string,
  profiles: Map<string, PublicProfile>,
  recipients: Map<string, string[]>,
  now: number,
): Broadcast {
  const isOwner = row.owner_id === viewerId;
  const isParticipant = row.is_participant === 1;
  return {
    id: row.id,
    direction: isOwner ? "sent" : "received",
    owner: profiles.get(row.owner_id) ?? unknownProfile(row.owner_id),
    status: viewerStatus({ stored: row.status, expiresAt: row.expires_at, isOwner, isParticipant }, now),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    area: row.area,
    message: row.message,
    url: row.url,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    recipients: isOwner
      ? (recipients.get(row.id) ?? []).map((id) => profiles.get(id) ?? unknownProfile(id))
      : null,
    responseCount: isOwner ? ownerResponseCount(row.status, row.responding, row.participant_count) : null,
    respondedByMe: isOwner ? null : row.my_responded_at !== null,
    meetupId: isParticipant || (isOwner && row.status === "decided") ? row.meetup_id : null,
  };
}

async function dtos(ctx: Ctx, viewerId: string, rows: repo.BroadcastRow[]) {
  // 宛先は募集者の行についてだけ読む（自分で選んだ相手）
  const ownRows = rows.filter((r) => r.owner_id === viewerId).map((r) => r.id);
  const recipients = await repo.recipientsOf(ctx.env.DB, ownRows);
  const ids = new Set(rows.map((r) => r.owner_id));
  for (const list of recipients.values()) for (const id of list) ids.add(id);
  const profiles = await getPublicProfiles(ctx.env, [...ids]);
  const now = ctx.deps.now();
  return rows.map((r) => toDto(r, viewerId, profiles, recipients, now));
}

async function reload(ctx: Ctx, viewerId: string, id: string) {
  const row = await repo.findBroadcastFor(ctx.env.DB, viewerId, id);
  if (!row) return null;
  const [dto] = await dtos(ctx, viewerId, [row]);
  return dto ?? null;
}

// ---- 作成 ----

export type CreateResult =
  | { kind: "created"; broadcast: Broadcast }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export async function createBroadcast(ctx: Ctx, viewerId: string, input: CreateBroadcastRequest): Promise<CreateResult> {
  const now = ctx.deps.now();
  const startsAt = Date.parse(input.startsAt);
  const endsAt = Date.parse(input.endsAt);
  if (checkInviteTime(startsAt, endsAt, now)) return { kind: "invalid" };
  const row: repo.NewBroadcast = {
    id: crypto.randomUUID(),
    ownerId: viewerId,
    recipientIds: input.recipientIds,
    startsAt,
    endsAt,
    area: input.area,
    message: input.message,
    url: input.url,
    expiresAt: expiresAtFor(input.expiresIn, startsAt, now),
    now,
  };
  const since = now - SEND_WINDOW_MS;
  const outcome = await attemptSend(
    () => repo.insertBroadcast(ctx.env.DB, row, { count: DAILY_SEND_LIMIT, since }),
    () => repo.diagnoseBroadcast(ctx.env.DB, row, since),
    now,
  );
  if (outcome.kind === "not_found" || outcome.kind === "rate_limited") return outcome;
  if (outcome.kind === "duplicate") return { kind: "conflict" };
  const broadcast = await reload(ctx, viewerId, row.id);
  return broadcast ? { kind: "created", broadcast } : { kind: "not_found" };
}

// ---- 取得 ----

export async function getBroadcast(ctx: Ctx, viewerId: string, id: string) {
  return reload(ctx, viewerId, id);
}

export async function listBroadcasts(
  ctx: Ctx,
  viewerId: string,
  box: "received" | "sent",
  limit: number,
  cursor: Cursor | null,
) {
  const rows = await repo.listBroadcasts(ctx.env.DB, viewerId, box, limit, cursor);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await dtos(ctx, viewerId, page),
    nextCursor: rows.length > limit && last ? { k: last.created_at, id: last.id } : null,
  };
}

// ---- 応じる・やめる・決める ----

export type TransitionResult =
  | { kind: "ok"; broadcast: Broadcast }
  | { kind: "not_found" }
  | { kind: "conflict"; reason: TransitionError };

async function done(ctx: Ctx, viewerId: string, id: string): Promise<TransitionResult> {
  const broadcast = await reload(ctx, viewerId, id);
  return broadcast ? { kind: "ok", broadcast } : { kind: "not_found" };
}

/** 応じる（respond = true）・やめる。宛先の人だけ（募集者・宛先でない人は404） */
export async function setResponse(ctx: Ctx, viewerId: string, id: string, respond: boolean): Promise<TransitionResult> {
  const row = await repo.findBroadcastFor(ctx.env.DB, viewerId, id);
  if (!row || row.owner_id === viewerId) return { kind: "not_found" };
  if (await repo.setResponse(ctx.env.DB, id, viewerId, respond, ctx.deps.now())) return done(ctx, viewerId, id);
  const latest = await repo.findBroadcastFor(ctx.env.DB, viewerId, id);
  if (!latest) return { kind: "not_found" };
  const reason = respondError({ isParticipant: latest.is_participant === 1, expiresAt: latest.expires_at }, ctx.deps.now());
  return { kind: "conflict", reason: reason ?? "invalid_state" };
}

/** 決める。募集者だけ（宛先の人・宛先でない人は404） */
export async function decide(ctx: Ctx, viewerId: string, id: string): Promise<TransitionResult> {
  const row = await repo.findBroadcastFor(ctx.env.DB, viewerId, id);
  if (!row || row.owner_id !== viewerId) return { kind: "not_found" };
  const ids = { meetupId: crypto.randomUUID(), decidedEventId: crypto.randomUUID(), confirmedEventId: crypto.randomUUID() };
  if (await repo.decideBroadcast(ctx.env.DB, viewerId, id, ids, ctx.deps.now())) return done(ctx, viewerId, id);
  const latest = await repo.findBroadcastFor(ctx.env.DB, viewerId, id);
  if (!latest) return { kind: "not_found" };
  const reason = decideError(
    { stored: latest.status, expiresAt: latest.expires_at, responding: latest.responding },
    ctx.deps.now(),
  );
  return { kind: "conflict", reason: reason ?? "invalid_state" };
}
