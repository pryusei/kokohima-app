-- T-10 冪等キー・回数の上限（docs/specs/T-10-idempotency-cache-ratelimit.md「データ」）

-- Idempotency-Key の1回目の応答。利用者ごと。24時間で消す
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
  status INTEGER,
  content_type TEXT,
  body TEXT,
  location TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_expires ON idempotency_keys (expires_at);

-- ics-links の発行数の上限（直近5分の本数を利用者ごとに数える）
CREATE INDEX ics_tokens_user_created ON ics_tokens (user_id, created_at);
