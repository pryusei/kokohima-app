-- T-05 募集（docs/specs/T-05-broadcast.md の「データ」）。日時はUnixミリ秒
-- expired・closed は保存せず、読むときに閲覧者ごとに決める

CREATE TABLE broadcasts (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  area TEXT,
  message TEXT,
  url TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  transition_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX broadcasts_owner ON broadcasts (owner_id, created_at, id);

-- responded_at：今応じていればその最初の時刻。やめたら NULL（履歴は残さない）
CREATE TABLE broadcast_recipients (
  broadcast_id TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  responded_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (broadcast_id, user_id)
);
CREATE INDEX broadcast_recipients_user ON broadcast_recipients (user_id, created_at, broadcast_id);

-- 募集から作った予定。ADD COLUMN では UNIQUE を付けられないので、別に UNIQUE INDEX を作る
ALTER TABLE meetups ADD COLUMN broadcast_id TEXT REFERENCES broadcasts(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX meetups_broadcast ON meetups (broadcast_id);

-- 募集の予定の「やっぱり難しい」で抜けた時刻と、抜けた遷移の値
ALTER TABLE meetup_participants ADD COLUMN left_at INTEGER;
ALTER TABLE meetup_participants ADD COLUMN left_transition_id TEXT;
