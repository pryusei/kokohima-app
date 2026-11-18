import type { IcsLink } from "@kokohima/shared";
import { meetupForActiveParticipant } from "../../invitation/application/calendarFacing";
import { randomToken, sha256 } from "../../shared/crypto";
import { buildIcs } from "../domain/ics";
import * as repo from "../infra/repository";
import type { Ctx } from "./connections";
import { eventContent } from "./eventContent";

// .ics（docs/specs/T-06-calendar.md「.ics」決定事項10・14）。一時的な URL を発行し、使うたびに参加者を確かめ直す
// トークンはハッシュだけを保存する。アプリのログにはトークンもパスも出さない

export const ICS_TOKEN_TTL_MS = 5 * 60 * 1000;

/** 閲覧者が抜けていない参加者の予定だけ。それ以外は null（404） */
/** 発行数の上限：直近5分で20本まで（docs/specs/T-10-idempotency-cache-ratelimit.md） */
export const ICS_LINK_LIMIT = 20;
export const ICS_LINK_WINDOW_MS = 5 * 60 * 1000;

export type CreateIcsLinkResult =
  | { kind: "ok"; link: IcsLink }
  | { kind: "not_found" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export async function createIcsLink(ctx: Ctx, viewerId: string, meetupId: string): Promise<CreateIcsLinkResult> {
  const meetup = await meetupForActiveParticipant(ctx, viewerId, meetupId);
  if (!meetup) return { kind: "not_found" };
  const now = ctx.deps.now();
  const token = randomToken();
  const expiresAt = now + ICS_TOKEN_TTL_MS;
  const inserted = await repo.insertIcsToken(
    ctx.env.DB,
    { tokenHash: await sha256(token), userId: viewerId, meetupId, expiresAt, now },
    { limit: ICS_LINK_LIMIT, windowMs: ICS_LINK_WINDOW_MS },
  );
  if (!inserted) {
    const oldest = await repo.oldestRecentIcsToken(ctx.env.DB, viewerId, now - ICS_LINK_WINDOW_MS);
    const waitMs = oldest === null ? 1000 : oldest + ICS_LINK_WINDOW_MS - now;
    return { kind: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  return { kind: "ok", link: { url: `${ctx.env.APP_ORIGIN}/api/v1/ics/${token}`, expiresAt: new Date(expiresAt).toISOString() } };
}

/** トークンの .ics。トークンがない・期限切れ・参加者でなくなったら null（すべて同じ404） */
export async function icsFor(ctx: Ctx, token: string): Promise<{ meetupId: string; body: string } | null> {
  const now = ctx.deps.now();
  const row = await repo.findIcsToken(ctx.env.DB, await sha256(token), now);
  if (!row) return null;
  const meetup = await meetupForActiveParticipant(ctx, row.user_id, row.meetup_id);
  if (!meetup) return null;
  const content = await eventContent(ctx, meetup, row.user_id);
  const cancelled = meetup.status === "cancelled";
  return {
    meetupId: meetup.id,
    body: buildIcs({
      uid: `${meetup.id}@kokohima`,
      stamp: now,
      startsAt: meetup.startsAt,
      endsAt: meetup.endsAt,
      summary: content.title,
      location: content.location,
      description: content.description,
      status: cancelled ? "CANCELLED" : "CONFIRMED",
      sequence: cancelled ? 1 : 0,
    }),
  };
}
