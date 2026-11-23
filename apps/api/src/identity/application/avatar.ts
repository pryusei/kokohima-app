import { RETENTION } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { hmacTag, timingSafeEqual } from "../../shared/crypto";
import { sanitizeAvatarJpeg, type AvatarJpegError } from "../domain/avatarJpeg";
import { avatarPath, avatarSigningInput, avatarUrlExpiry, isAvatarExpiryAcceptable } from "../domain/avatarUrl";
import * as repo from "../infra/repository";

// アイコンの画像（docs/specs/T-27-avatar-upload.md）。置く・外す・配信・署名つき URL・掃除

type Ctx = { env: Bindings; deps: AppDeps };

const HOUR_MS = 60 * 60 * 1000;
/** 置いてから、参照されなくなった画像を消すまで（台帳の行が書かれてから users を書くまでの間を消さないため） */
export const AVATAR_GRACE_MS = RETENTION.avatarImageGraceHours * HOUR_MS;
export const AVATAR_CLEANUP_LIMIT = 100;

const avatarKey = (avatarId: string) => `avatars/v1/${avatarId}`;

/**
 * 署名つきの相対 URL。avatarId がなければ null。
 * 鍵（AVATAR_URL_KEY）がない・壊れているときも null にし、プロフィールを返す経路を止めない（画面は1文字めに戻るだけ）。
 * ログには鍵の値を出さず、イベント名だけを残す
 */
export async function avatarUrlFor(ctx: Ctx, avatarId: string | null): Promise<string | null> {
  if (!avatarId) return null;
  const expiry = avatarUrlExpiry(ctx.deps.now());
  try {
    const signature = await hmacTag(ctx.env.AVATAR_URL_KEY ?? "", avatarSigningInput(avatarId, expiry));
    return avatarPath(avatarId, expiry, signature);
  } catch {
    console.log(JSON.stringify({ event: "avatar_url_key_invalid" }));
    return null;
  }
}

export type UploadResult = { kind: "ok" } | { kind: "invalid"; error: AvatarJpegError } | { kind: "not_found" };

/** 閲覧者自身のアイコンを置き換える（前の画像は掃除が消す） */
export async function uploadAvatar(ctx: Ctx, viewerId: string, body: Uint8Array): Promise<UploadResult> {
  const checked = sanitizeAvatarJpeg(body);
  if (!checked.ok) return { kind: "invalid", error: checked.error };
  const now = ctx.deps.now();
  const avatarId = crypto.randomUUID();
  // 台帳 → R2 → users の順。途中で失敗しても、台帳の行と R2 の物は掃除が消す
  await repo.insertAvatarImage(ctx.env.DB, avatarId, now);
  await ctx.env.AVATARS.put(avatarKey(avatarId), checked.bytes, { httpMetadata: { contentType: "image/jpeg" } });
  const updated = await repo.setAvatarId(ctx.env.DB, viewerId, avatarId, now);
  return updated ? { kind: "ok" } : { kind: "not_found" };
}

/** 閲覧者自身のアイコンを外す。もともとなくてもよい */
export async function removeAvatar(ctx: Ctx, viewerId: string) {
  await repo.setAvatarId(ctx.env.DB, viewerId, null, ctx.deps.now());
}

/**
 * 配信：署名と期限を確かめてから、利用中の誰かの今のアイコンなら R2 から読む。外れたら null（どこで外れても同じ404）。
 * 署名が違うときは D1・R2 を読まない
 */
export async function avatarImageFor(ctx: Ctx, avatarId: string, expiryText: string | undefined, signature: string | undefined) {
  if (!expiryText || !/^\d{1,12}$/.test(expiryText) || !signature || signature.length > 64) return null;
  const expiry = Number(expiryText);
  if (!isAvatarExpiryAcceptable(expiry, ctx.deps.now())) return null;
  let expected: string;
  try {
    expected = await hmacTag(ctx.env.AVATAR_URL_KEY ?? "", avatarSigningInput(avatarId, expiry));
  } catch {
    console.log(JSON.stringify({ event: "avatar_url_key_invalid" }));
    return null;
  }
  if (!timingSafeEqual(expected, signature)) return null;
  if (!(await repo.isCurrentAvatar(ctx.env.DB, avatarId))) return null;
  const object = await ctx.env.AVATARS.get(avatarKey(avatarId));
  return object ? object.body : null;
}

/** 参照されない古い画像を R2 と台帳から消す（毎分。1回で扱うのは AVATAR_CLEANUP_LIMIT まで） */
export async function cleanupAvatars(ctx: Ctx) {
  const d1 = ctx.env.DB;
  const orphans = await repo.orphanAvatarImages(d1, ctx.deps.now() - AVATAR_GRACE_MS, AVATAR_CLEANUP_LIMIT);
  if (orphans.length === 0) return;
  try {
    await ctx.env.AVATARS.delete(orphans.map(avatarKey));
  } catch (e) {
    // R2 の削除に失敗したら台帳の行を残し、次の回でやり直す
    console.log(JSON.stringify({ event: "avatar_cleanup_failed", name: (e as Error).name }));
    return;
  }
  await repo.deleteAvatarLedger(d1, orphans);
}
