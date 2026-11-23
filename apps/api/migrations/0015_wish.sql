-- T-22 行きたいリスト（docs/specs/T-22-wishlist.md「データ」）

CREATE TABLE wishes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  area TEXT,
  url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX wishes_owner_created ON wishes (owner_id, created_at, id);

-- 行きたいごとの見せない相手。友達を解除しても残す（決めたこと10）
CREATE TABLE wish_exclusions (
  wish_id TEXT NOT NULL REFERENCES wishes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (wish_id, user_id)
);
CREATE INDEX wish_exclusions_user ON wish_exclusions (user_id);

-- 置いた回数を数える記録。行きたいを消しても残し、2日で消す。中身は持たない
CREATE TABLE wish_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX wish_posts_user_created ON wish_posts (user_id, created_at);
-- 2日を過ぎた記録の掃除（T-17）
CREATE INDEX wish_posts_created ON wish_posts (created_at);

-- link_preview_refs に行きたいを足す。CHECK を変えるため表を作り直す（SQLite は CHECK を変えられない）
CREATE TABLE link_preview_refs_new (
  id TEXT PRIMARY KEY,
  direct_invite_id TEXT UNIQUE REFERENCES direct_invites(id) ON DELETE CASCADE,
  broadcast_id TEXT UNIQUE REFERENCES broadcasts(id) ON DELETE CASCADE,
  wish_id TEXT UNIQUE REFERENCES wishes(id) ON DELETE CASCADE,
  preview_id TEXT NOT NULL REFERENCES link_previews(id),
  created_at INTEGER NOT NULL,
  CHECK ((direct_invite_id IS NOT NULL) + (broadcast_id IS NOT NULL) + (wish_id IS NOT NULL) = 1)
);
INSERT INTO link_preview_refs_new (id, direct_invite_id, broadcast_id, preview_id, created_at)
  SELECT id, direct_invite_id, broadcast_id, preview_id, created_at FROM link_preview_refs;
DROP TABLE link_preview_refs;
ALTER TABLE link_preview_refs_new RENAME TO link_preview_refs;
CREATE INDEX link_preview_refs_preview ON link_preview_refs (preview_id);
