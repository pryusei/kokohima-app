-- T-04 個別の誘いと成立した予定（docs/specs/T-04-direct-invite.md の「データ」）。日時はUnixミリ秒
-- 断りの理由の列は作らない。期限切れ（expired）は保存せず、読むときに決める
-- transition_id：状態遷移ごとのランダムな値。同じ batch の後続の文が「この遷移で書いた状態か」を見分けるのに使う

CREATE TABLE direct_invites (
  id TEXT PRIMARY KEY NOT NULL,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  area TEXT,
  message TEXT,
  url TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  counter_starts_at INTEGER,
  counter_ends_at INTEGER,
  responded_at INTEGER,
  decided_at INTEGER,
  transition_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX direct_invites_sender ON direct_invites (sender_id, created_at, id);
CREATE INDEX direct_invites_recipient ON direct_invites (recipient_id, created_at, id);
CREATE INDEX direct_invites_same ON direct_invites (sender_id, recipient_id, starts_at);

CREATE TABLE meetups (
  id TEXT PRIMARY KEY NOT NULL,
  direct_invite_id TEXT UNIQUE REFERENCES direct_invites(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  transition_id TEXT,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX meetups_starts_at ON meetups (starts_at, id);

CREATE TABLE meetup_participants (
  meetup_id TEXT NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meetup_id, user_id)
);
CREATE INDEX meetup_participants_user ON meetup_participants (user_id, meetup_id);
