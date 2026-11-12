-- T-06 カレンダー連携（docs/specs/T-06-calendar.md の「データ」）。日時はUnixミリ秒

CREATE TABLE calendar_connections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  refresh_token_enc TEXT,
  calendar_id TEXT,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 前回確かめた埋まり（[[開始, 終了], ...] の JSON。予定の中身は持たない）とその範囲
  busy_snapshot TEXT,
  snapshot_from INTEGER,
  snapshot_to INTEGER,
  last_synced_at INTEGER,
  sync_id TEXT,
  sync_lease_until INTEGER,
  large_change_held INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, provider)
);
CREATE INDEX calendar_connections_sync ON calendar_connections (status, last_synced_at);

CREATE TABLE calendar_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  binding_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX calendar_oauth_states_user ON calendar_oauth_states (user_id, created_at);
CREATE INDEX calendar_oauth_states_created ON calendar_oauth_states (created_at);

CREATE TABLE ics_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meetup_id TEXT NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ics_tokens_created ON ics_tokens (created_at);

-- outbox の取り出し（型で絞って古い順）
CREATE INDEX outbox_type_unprocessed ON outbox (type, processed_at, created_at);
