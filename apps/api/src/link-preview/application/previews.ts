import { RETENTION, type LinkPreview } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { IMAGE_TYPES, type ImageType } from "../domain/image";
import * as repo from "../infra/repository";
import { imageKey } from "./fetchPreview";

// プレビューの読み取り・画像の配信・掃除（docs/specs/T-08-link-preview.md「API」「配信」「掃除」）

type Ctx = { env: Bindings; deps: AppDeps };

const PENDING: LinkPreview = { status: "pending", title: null, description: null, siteName: null, imageUrl: null };
const FAILED: LinkPreview = { ...PENDING, status: "failed" };

export const imageUrlOf = (imageId: string) => `/api/v1/link-previews/images/${imageId}`;

export type SubjectLink = { directInviteId: string | null; broadcastId: string | null; wishId?: string | null; url: string | null };

/**
 * 誘い・募集・予定・行きたいのプレビュー。呼び出し側（invitation・wish）が閲覧者で絞って読んだ行だけを渡す。
 * 返す配列は渡した順。リンクがなければ null、参照の行がなければ pending
 */
export async function previewsFor(d1: D1Database, subjects: SubjectLink[]): Promise<(LinkPreview | null)[]> {
  const withLink = subjects.filter((s) => s.url !== null);
  const inviteIds = [...new Set(withLink.map((s) => s.directInviteId).filter((v): v is string => v !== null))];
  const broadcastIds = [...new Set(withLink.filter((s) => s.directInviteId === null).map((s) => s.broadcastId).filter((v): v is string => v !== null))];
  const wishIds = [...new Set(withLink.map((s) => s.wishId ?? null).filter((v): v is string => v !== null))];
  const [invites, broadcasts, wishes] = await Promise.all([
    repo.previewsOf(d1, "direct_invite_id", inviteIds),
    repo.previewsOf(d1, "broadcast_id", broadcastIds),
    repo.previewsOf(d1, "wish_id", wishIds),
  ]);
  const byInvite = new Map(invites.map((r) => [r.subject_id, r]));
  const byBroadcast = new Map(broadcasts.map((r) => [r.subject_id, r]));
  const byWish = new Map(wishes.map((r) => [r.subject_id, r]));
  return subjects.map((s) => {
    if (s.url === null) return null;
    const row =
      s.directInviteId !== null
        ? byInvite.get(s.directInviteId)
        : s.broadcastId !== null
          ? byBroadcast.get(s.broadcastId)
          : s.wishId
            ? byWish.get(s.wishId)
            : undefined;
    if (!row || row.status === "fetching") return PENDING;
    if (row.status === "failed") return FAILED;
    return {
      status: "ok",
      title: row.title,
      description: row.description,
      siteName: row.site_name,
      imageUrl: row.image_id ? imageUrlOf(row.image_id) : null,
    };
  });
}

/** 配信する画像。status が ok の行の画像で、決まった種類のものだけ。なければ null */
export async function imageFor(ctx: Ctx, imageId: string): Promise<{ body: ReadableStream; type: ImageType } | null> {
  const type = await repo.imageTypeOf(ctx.env.DB, imageId);
  if (!type || !(IMAGE_TYPES as readonly string[]).includes(type)) return null;
  const object = await ctx.env.OGP_IMAGES.get(imageKey(imageId));
  if (!object) return null;
  return { body: object.body, type: type as ImageType };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const PREVIEW_RETENTION_MS = RETENTION.linkPreviewsDays * DAY_MS;
export const FETCHING_ABANDONED_MS = HOUR_MS;
export const IMAGE_GRACE_MS = RETENTION.linkPreviewImageGraceHours * HOUR_MS;
export const CLEANUP_LIMIT = 100;

/** 参照されない古い結果の行と、台帳から参照されない画像を消す（毎分。1回で扱う行の数は CLEANUP_LIMIT まで） */
export async function cleanupLinkPreviews(ctx: Ctx) {
  const now = ctx.deps.now();
  const d1 = ctx.env.DB;
  await repo.deleteStalePreviews(d1, now - PREVIEW_RETENTION_MS, now - FETCHING_ABANDONED_MS, CLEANUP_LIMIT);
  const orphans = await repo.orphanImages(d1, now - IMAGE_GRACE_MS, CLEANUP_LIMIT);
  if (orphans.length === 0) return;
  try {
    await ctx.env.OGP_IMAGES.delete(orphans.map(imageKey));
  } catch (e) {
    // R2 の削除に失敗したら台帳の行を残し、次の回でやり直す
    console.log(JSON.stringify({ event: "link_preview_cleanup_failed", name: (e as Error).name }));
    return;
  }
  await repo.deleteImageLedger(d1, orphans);
}

/** 退会（T-16）：退会した人の誘い・募集の参照を消す文。invitation の後始末の batch に入れる */
export const withdrawalDeleteRefsStatements = (d1: D1Database, userId: string) =>
  repo.withdrawalDeleteRefsStatements(d1, userId);
