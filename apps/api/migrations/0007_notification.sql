-- T-07 通知（docs/specs/T-07-notification.md の「データ」）。日時はUnixミリ秒

CREATE TABLE notifications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- 相手と対象は ID だけを持つ（名前・ひとこと・時刻は持たない）
  actor_id TEXT,
  subject_id TEXT,
  count INTEGER,
  device TEXT,
  event_id TEXT NOT NULL,
  -- created_at はイベントが起きた時刻（表示用）、inserted_at は行を作った時刻（並びと既読の基準）
  created_at INTEGER NOT NULL,
  inserted_at INTEGER NOT NULL,
  read_at INTEGER,
  channel TEXT,
  counted_push_at INTEGER,
  counted_email_at INTEGER,
  delivered_at INTEGER,
  outcome TEXT,
  UNIQUE (event_id, user_id)
);
CREATE INDEX notifications_user_inserted ON notifications (user_id, inserted_at, id);
CREATE INDEX notifications_user_read ON notifications (user_id, read_at);
CREATE INDEX notifications_inserted ON notifications (inserted_at);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL UNIQUE,
  endpoint_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER
);
CREATE INDEX push_subscriptions_user ON push_subscriptions (user_id, created_at);
CREATE INDEX push_subscriptions_session ON push_subscriptions (session_id);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invites INTEGER NOT NULL DEFAULT 1,
  broadcasts INTEGER NOT NULL DEFAULT 1,
  meetups INTEGER NOT NULL DEFAULT 1,
  friends INTEGER NOT NULL DEFAULT 1,
  calendar INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 1日の数。user_id が '' の行は、サービス全体のメールの数（外部キーは付けない）
CREATE TABLE notification_daily_counts (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, channel)
);
