// link-preview の表（docs/specs/T-08-link-preview.md「データ」）。状態の遷移はどれも WHERE status = ? の条件付き

export type Subject = { type: "direct_invite" | "broadcast"; id: string };

export type PreviewRow = {
  id: string;
  status: "fetching" | "ok" | "failed";
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_id: string | null;
  image_type: string | null;
  claimed_at: number;
  fetched_at: number | null;
};

const refColumn = (s: Subject) => (s.type === "direct_invite" ? "direct_invite_id" : "broadcast_id");
const subjectTable = (s: Subject) => (s.type === "direct_invite" ? "direct_invites" : "broadcasts");

export async function hasRef(d1: D1Database, subject: Subject) {
  const row = await d1.prepare(`SELECT 1 AS x FROM link_preview_refs WHERE ${refColumn(subject)} = ?1`).bind(subject.id).first();
  return row !== null;
}

/** 使い回せる結果（ok は okSince より後、failed は failedSince より後に終えた、いちばん新しいもの） */
export async function findReusable(d1: D1Database, urlHash: string, okSince: number, failedSince: number) {
  return d1
    .prepare(
      `SELECT id FROM link_previews
       WHERE url_hash = ?1 AND ((status = 'ok' AND fetched_at > ?2) OR (status = 'failed' AND fetched_at > ?3))
       ORDER BY fetched_at DESC LIMIT 1`,
    )
    .bind(urlHash, okSince, failedSince)
    .first<{ id: string }>();
}

/** 取得の権利を取る。同じ URL の fetching の行があれば入らず false */
export async function claim(d1: D1Database, id: string, urlHash: string, now: number) {
  const r = await d1
    .prepare("INSERT OR IGNORE INTO link_previews (id, url_hash, status, claimed_at) VALUES (?1, ?2, 'fetching', ?3)")
    .bind(id, urlHash, now)
    .run();
  return r.meta.changes === 1;
}

/** staleBefore より前に取られた fetching の行を引き継ぐ。引き継げたら行の ID */
export async function takeOver(d1: D1Database, urlHash: string, staleBefore: number, now: number) {
  const row = await d1
    .prepare(
      `UPDATE link_previews SET claimed_at = ?3
       WHERE id = (SELECT id FROM link_previews WHERE url_hash = ?1 AND status = 'fetching' AND claimed_at < ?2)
         AND status = 'fetching' AND claimed_at < ?2
       RETURNING id`,
    )
    .bind(urlHash, staleBefore, now)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** 取得の権利を手放す（自分が取った時刻のままのときだけ） */
export async function release(d1: D1Database, id: string, claimedAt: number) {
  await d1
    .prepare("DELETE FROM link_previews WHERE id = ?1 AND status = 'fetching' AND claimed_at = ?2")
    .bind(id, claimedAt)
    .run();
}

export type Finished =
  | { status: "ok"; title: string | null; description: string | null; siteName: string | null; imageId: string | null; imageType: string | null }
  | { status: "failed" };

/** 取得を終える。行がまだ fetching のときだけ書く。書けたら true */
export async function finish(d1: D1Database, id: string, result: Finished, now: number) {
  const ok = result.status === "ok" ? result : null;
  const r = await d1
    .prepare(
      `UPDATE link_previews
       SET status = ?2, title = ?3, description = ?4, site_name = ?5, image_id = ?6, image_type = ?7, fetched_at = ?8
       WHERE id = ?1 AND status = 'fetching'`,
    )
    .bind(id, result.status, ok?.title ?? null, ok?.description ?? null, ok?.siteName ?? null, ok?.imageId ?? null, ok?.imageType ?? null, now)
    .run();
  return r.meta.changes === 1;
}

/** 権利なしで failed の行を入れる（最後の試行で、ほかの処理が取得中のとき） */
export async function insertFailed(d1: D1Database, id: string, urlHash: string, now: number) {
  await d1
    .prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at, fetched_at) VALUES (?1, ?2, 'failed', ?3, ?3)")
    .bind(id, urlHash, now)
    .run();
}

export async function findPreview(d1: D1Database, id: string) {
  return d1.prepare("SELECT * FROM link_previews WHERE id = ?1").bind(id).first<PreviewRow>();
}

/** 参照の行を書く。誘い・募集がない（処理の間に消えた）・すでにあるなら書かない。書けたら true */
export async function insertRef(d1: D1Database, subject: Subject, previewId: string, now: number) {
  const r = await d1
    .prepare(
      `INSERT OR IGNORE INTO link_preview_refs (id, ${refColumn(subject)}, preview_id, created_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM ${subjectTable(subject)} WHERE id = ?2)`,
    )
    .bind(crypto.randomUUID(), subject.id, previewId, now)
    .run();
  return r.meta.changes === 1;
}

/** R2 に置く前に台帳の行を書く */
export async function insertImageLedger(d1: D1Database, imageId: string, now: number) {
  await d1.prepare("INSERT INTO link_preview_images (image_id, created_at) VALUES (?1, ?2)").bind(imageId, now).run();
}

export type RefPreview = { subject_id: string } & Pick<PreviewRow, "status" | "title" | "description" | "site_name" | "image_id">;

/** 誘い・募集の ID ごとに、参照している結果 */
export async function previewsOf(d1: D1Database, column: "direct_invite_id" | "broadcast_id", ids: string[]) {
  if (ids.length === 0) return [];
  const { results } = await d1
    .prepare(
      `SELECT r.${column} AS subject_id, p.status, p.title, p.description, p.site_name, p.image_id
       FROM link_preview_refs r JOIN link_previews p ON p.id = r.preview_id
       WHERE r.${column} IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(ids))
    .all<RefPreview>();
  return results;
}

/** 配信してよい画像の種類（status が ok の行の画像だけ） */
export async function imageTypeOf(d1: D1Database, imageId: string) {
  const row = await d1
    .prepare("SELECT image_type FROM link_previews WHERE image_id = ?1 AND status = 'ok'")
    .bind(imageId)
    .first<{ image_type: string | null }>();
  return row?.image_type ?? null;
}

const UNREFERENCED = "NOT EXISTS (SELECT 1 FROM link_preview_refs r WHERE r.preview_id = p.id)";

/** 参照されていない古い結果の行を消す（上限つき）。消した数 */
export async function deleteStalePreviews(d1: D1Database, doneBefore: number, fetchingBefore: number, limit: number) {
  const r = await d1
    .prepare(
      `DELETE FROM link_previews WHERE id IN (
         SELECT p.id FROM link_previews p
         WHERE ${UNREFERENCED}
           AND ((p.status IN ('ok', 'failed') AND p.fetched_at < ?1) OR (p.status = 'fetching' AND p.claimed_at < ?2))
         LIMIT ?3)
       AND ${UNREFERENCED.replaceAll("p.id", "link_previews.id")}`,
    )
    .bind(doneBefore, fetchingBefore, limit)
    .run();
  return r.meta.changes;
}

/** 台帳のうち、createdBefore より前に置かれ、結果の行から参照されていない画像（上限つき） */
export async function orphanImages(d1: D1Database, createdBefore: number, limit: number) {
  const { results } = await d1
    .prepare(
      `SELECT i.image_id FROM link_preview_images i
       WHERE i.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM link_previews p WHERE p.image_id = i.image_id)
       ORDER BY i.created_at LIMIT ?2`,
    )
    .bind(createdBefore, limit)
    .all<{ image_id: string }>();
  return results.map((r) => r.image_id);
}

/** 台帳の行を消す（まだ参照されていないときだけ） */
export async function deleteImageLedger(d1: D1Database, imageIds: string[]) {
  if (imageIds.length === 0) return;
  await d1
    .prepare(
      `DELETE FROM link_preview_images
       WHERE image_id IN (SELECT value FROM json_each(?1))
         AND NOT EXISTS (SELECT 1 FROM link_previews p WHERE p.image_id = link_preview_images.image_id)`,
    )
    .bind(JSON.stringify(imageIds))
    .run();
}
