-- T-02 友達と招待リンク（docs/specs/T-02-friends.md の「データ」）。日時はすべてUnixミリ秒

CREATE TABLE invite_links (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX invite_links_token_hash ON invite_links (token_hash);
CREATE INDEX invite_links_owner_created ON invite_links (owner_id, created_at, id);

-- 1組の友達を両方向の2行で持つ
CREATE TABLE friendships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX friendships_user_created ON friendships (user_id, created_at, friend_id);

-- 行がなければ「見せる」（F-07の初期値）。友達を解除しても消さない
CREATE TABLE sharing_policies (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, target_id)
);
