-- アイコンの画像（docs/specs/T-27-avatar-upload.md「データ」）
-- users.avatar_url は使っておらず常に NULL なので、名前を変えるだけ（データの移行はない）
ALTER TABLE users RENAME COLUMN avatar_url TO avatar_id;

-- 置いた画像の台帳。利用者 ID は持たない（どの画像が誰のものかは users.avatar_id だけが持つ）
CREATE TABLE avatar_images (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX avatar_images_created ON avatar_images (created_at);

-- 配信の確認（今のアイコンか）と掃除（参照されていないか）で引く
CREATE INDEX users_avatar_id ON users (avatar_id);
