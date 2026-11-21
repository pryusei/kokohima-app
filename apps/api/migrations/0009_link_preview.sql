-- T-08 リンクのプレビュー（docs/specs/T-08-link-preview.md「データ」）

-- 取得の結果。URL ごとに、取得のたびに1行。URL そのものは持たない（誘い・募集の url 列にある）
CREATE TABLE link_previews (
  id TEXT PRIMARY KEY,
  url_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('fetching', 'ok', 'failed')),
  title TEXT,
  description TEXT,
  site_name TEXT,
  image_id TEXT UNIQUE,
  image_type TEXT,
  claimed_at INTEGER NOT NULL,
  fetched_at INTEGER
);
CREATE INDEX link_previews_url ON link_previews (url_hash, fetched_at);
-- 同じ URL を同時に取りに行くのは1つだけ
CREATE UNIQUE INDEX link_previews_fetching ON link_previews (url_hash) WHERE status = 'fetching';

-- R2 に置いた画像の台帳。R2 に置く前に書き、R2 の画像を消すのはこの台帳から判定する掃除だけ
CREATE TABLE link_preview_images (
  image_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX link_preview_images_created ON link_preview_images (created_at);

-- 誘い・募集がどの結果を見せるか。誘い・募集が消えたら一緒に消える
CREATE TABLE link_preview_refs (
  id TEXT PRIMARY KEY,
  direct_invite_id TEXT UNIQUE REFERENCES direct_invites(id) ON DELETE CASCADE,
  broadcast_id TEXT UNIQUE REFERENCES broadcasts(id) ON DELETE CASCADE,
  preview_id TEXT NOT NULL REFERENCES link_previews(id),
  created_at INTEGER NOT NULL,
  CHECK ((direct_invite_id IS NULL) <> (broadcast_id IS NULL))
);
CREATE INDEX link_preview_refs_preview ON link_preview_refs (preview_id);
