import type { NotificationDto, NotificationPreferences } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles } from "../../identity/application/auth";
import type { Cursor } from "../../shared/cursor";
import * as repo from "../infra/repository";

// お知らせ一覧・既読・設定（docs/specs/T-07-notification.md「API」）。閲覧者自身の行だけを読み書きする

type Ctx = { env: Bindings; deps: AppDeps };

const iso = (ms: number) => new Date(ms).toISOString();
export const UNREAD_CAP = 99;

export async function listNotifications(ctx: Ctx, viewerId: string, limit: number, cursor: Cursor | null) {
  const rows = await repo.listNotifications(ctx.env.DB, viewerId, limit, cursor);
  const page = rows.slice(0, limit);
  // 相手は、閲覧者あてのお知らせに記録された ID だけ。読めなければ null。退会した人は withdrawn: true のプロフィール（T-16）
  const actorIds = [...new Set(page.flatMap((r) => (r.actor_id ? [r.actor_id] : [])))];
  const profiles = await getPublicProfiles(ctx.env, actorIds);
  const items: NotificationDto[] = page.map((r) => ({
    id: r.id,
    kind: r.kind,
    actor: r.actor_id ? (profiles.get(r.actor_id) ?? null) : null,
    subjectId: r.subject_id,
    count: r.count,
    device: r.device,
    createdAt: iso(r.created_at),
    readAt: r.read_at === null ? null : iso(r.read_at),
  }));
  const last = page.at(-1);
  return { items, nextCursor: rows.length > limit && last ? { k: last.inserted_at, id: last.id } : null };
}

export const unreadCount = (ctx: Ctx, viewerId: string) => repo.countUnread(ctx.env.DB, viewerId, UNREAD_CAP);

/** upTo が閲覧者のお知らせでなければ false */
export const markRead = (ctx: Ctx, viewerId: string, upTo: string) =>
  repo.markReadUpTo(ctx.env.DB, viewerId, upTo, ctx.deps.now());

const ALL_ON: NotificationPreferences = { invites: true, broadcasts: true, meetups: true, friends: true, calendar: true };

export async function getPreferences(ctx: Ctx, viewerId: string): Promise<NotificationPreferences> {
  const row = await repo.getPreferences(ctx.env.DB, viewerId);
  if (!row) return ALL_ON;
  return {
    invites: row.invites === 1,
    broadcasts: row.broadcasts === 1,
    meetups: row.meetups === 1,
    friends: row.friends === 1,
    calendar: row.calendar === 1,
  };
}

export async function patchPreferences(ctx: Ctx, viewerId: string, patch: Partial<NotificationPreferences>) {
  const next = { ...(await getPreferences(ctx, viewerId)), ...patch };
  await repo.putPreferences(ctx.env.DB, viewerId, next, ctx.deps.now());
  return next;
}
