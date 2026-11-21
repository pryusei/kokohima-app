import type { AppDeps, Bindings } from "../../env";
import { linkOfSubject } from "../../invitation/application/calendarFacing";
import { sha256 } from "../../shared/crypto";
import { acceptImage, IMAGE_MAX_BYTES } from "../domain/image";
import { charsetOfContentType, headOf, mediaTypeOf, metaCharset, parseOgp, stripIgnored } from "../domain/parse";
import { fetchableUrl, parseOwnDomains, TransientError, withoutFragment, type FetchPolicy } from "../domain/url";
import { fetchChecked } from "../infra/fetcher";
import * as repo from "../infra/repository";

// LinkAttached から取得して保存する（docs/specs/T-08-link-preview.md「取得のきっかけ」）

type Ctx = { env: Bindings; deps: AppDeps };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const OK_REUSE_MS = 7 * DAY_MS;
export const FAILED_REUSE_MS = DAY_MS;
export const CLAIM_STALE_MS = 10 * 60 * 1000;
export const PAGE_MAX_BYTES = 512 * 1024;

export const imageKey = (imageId: string) => `images/v1/${imageId}`;

type PageResult =
  | { kind: "ok"; title: string | null; description: string | null; siteName: string | null; imageId: string | null; imageType: string | null }
  | { kind: "failed" }
  | { kind: "transient" };

/** ログには結果の種類と状態コードだけを出す（URL・ホスト名・タイトル・IP は出さない） */
const log = (outcome: string, status?: number) =>
  console.log(JSON.stringify({ event: "link_preview_fetch", outcome, ...(status !== undefined ? { status } : {}) }));

function decode(body: Uint8Array, contentType: string): string | null {
  const sniffed = new TextDecoder("latin1").decode(body.subarray(0, 4096));
  const charset = charsetOfContentType(contentType) ?? metaCharset(headOf(stripIgnored(sniffed))) ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return null;
  }
}

/** 画像を取り、受け付けたら台帳に書いてから R2 に置く。だめなら null（ページの結果には影響させない） */
async function storeImage(ctx: Ctx, imageUrl: string, policy: FetchPolicy): Promise<{ imageId: string; imageType: string } | null> {
  const r = await fetchChecked(ctx.deps, imageUrl, { accept: "image/jpeg,image/png,image/webp,image/gif", maxBytes: IMAGE_MAX_BYTES, policy });
  if (r.kind !== "ok" || r.truncated) return null;
  const type = acceptImage(r.contentType, r.body);
  if (!type) return null;
  const imageId = crypto.randomUUID();
  await repo.insertImageLedger(ctx.env.DB, imageId, ctx.deps.now());
  await ctx.env.OGP_IMAGES.put(imageKey(imageId), r.body, { httpMetadata: { contentType: type } });
  return { imageId, imageType: type };
}

/** ページを取り、OGP と画像を読む */
async function fetchPage(ctx: Ctx, url: string, policy: FetchPolicy): Promise<PageResult> {
  const r = await fetchChecked(ctx.deps, url, { accept: "text/html,application/xhtml+xml", maxBytes: PAGE_MAX_BYTES, policy });
  if (r.kind !== "ok") {
    log(r.kind, r.status);
    return { kind: r.kind };
  }
  const media = mediaTypeOf(r.contentType);
  if (media !== "text/html" && media !== "application/xhtml+xml") return { kind: "failed" };
  const html = decode(r.body, r.contentType);
  if (html === null) return { kind: "failed" };
  const ogp = parseOgp(html);
  if (!ogp) return { kind: "failed" };
  // 相対の og:image は、リダイレクトを追ったあとのページの URL から解決する
  const image = ogp.image ? fetchableUrl(ogp.image, policy, r.url) : null;
  const stored = image ? await storeImage(ctx, image.href, policy).catch(() => null) : null;
  return {
    kind: "ok",
    title: ogp.title,
    description: ogp.description,
    siteName: ogp.siteName,
    imageId: stored?.imageId ?? null,
    imageType: stored?.imageType ?? null,
  };
}

/**
 * LinkAttached の処理。last はメッセージの最後の試行か（consumer が attempts > MAX_RETRIES で判定する）。
 * 最後の試行で失敗したら failed にして投げない
 */
export async function handleLinkAttached(ctx: Ctx, subject: repo.Subject, last: boolean): Promise<void> {
  const d1 = ctx.env.DB;
  if (await repo.hasRef(d1, subject)) return;
  const link = await linkOfSubject(ctx, subject);
  // 誘い・募集がない（消えた）・リンクがない
  if (link === null) return;
  const normalized = withoutFragment(link);
  if (normalized === null) return;
  const urlHash = await sha256(normalized);
  const now = ctx.deps.now();

  const reuse = await repo.findReusable(d1, urlHash, now - OK_REUSE_MS, now - FAILED_REUSE_MS);
  if (reuse) {
    await repo.insertRef(d1, subject, reuse.id, now);
    return;
  }

  const failLast = async (heldId: string | null) => {
    if (heldId && (await repo.finish(d1, heldId, { status: "failed" }, ctx.deps.now()))) {
      await repo.insertRef(d1, subject, heldId, ctx.deps.now());
      return;
    }
    const id = crypto.randomUUID();
    await repo.insertFailed(d1, id, urlHash, ctx.deps.now());
    await repo.insertRef(d1, subject, id, ctx.deps.now());
  };

  const ownDomains = parseOwnDomains(ctx.env.LINK_PREVIEW_OWN_DOMAINS);
  if (ownDomains === null) {
    console.log(JSON.stringify({ event: "link_preview_skipped", reason: "own_domains_not_set" }));
    if (last) return failLast(null);
    throw new TransientError("own_domains_not_set");
  }
  const policy: FetchPolicy = { ownDomains, extraHosts: ctx.deps.linkPreview.extraHosts };

  // 取得の権利を取る。取れなければ、10分を過ぎた行を引き継ぐ
  let previewId: string | null = crypto.randomUUID();
  const claimedAt = now;
  if (!(await repo.claim(d1, previewId, urlHash, claimedAt))) {
    previewId = await repo.takeOver(d1, urlHash, now - CLAIM_STALE_MS, claimedAt);
  }
  if (previewId === null) {
    if (last) return failLast(null);
    throw new TransientError("fetching_elsewhere");
  }

  // 取りに行ってよい URL でなければ、取らずに failed
  const target = fetchableUrl(normalized, policy);
  let result: PageResult;
  try {
    result = target ? await fetchPage(ctx, target.href, policy) : { kind: "failed" };
  } catch (e) {
    // 思わぬ例外も一時的な失敗として扱い、権利を手放す（最後の試行では failed）
    console.log(JSON.stringify({ event: "link_preview_fetch", outcome: "error", name: (e as Error).name }));
    result = { kind: "transient" };
  }
  if (result.kind === "transient") {
    if (last) return failLast(previewId);
    await repo.release(d1, previewId, claimedAt).catch(() => undefined);
    throw new TransientError("fetch_transient");
  }

  const finished: repo.Finished =
    result.kind === "ok"
      ? { status: "ok", title: result.title, description: result.description, siteName: result.siteName, imageId: result.imageId, imageType: result.imageType }
      : { status: "failed" };
  log(finished.status);
  if (await repo.finish(d1, previewId, finished, ctx.deps.now())) {
    await repo.insertRef(d1, subject, previewId, ctx.deps.now());
    return;
  }
  // 権利を引き継いだ側が先に終えた、または掃除で行が消えた
  const current = await repo.findPreview(d1, previewId);
  if (current && current.status !== "fetching") {
    await repo.insertRef(d1, subject, previewId, ctx.deps.now());
    return;
  }
  if (last) return failLast(null);
  throw new TransientError("claim_lost");
}
