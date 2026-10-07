-- T-01 認証（docs/specs/T-01-auth.md の「データ」）。日時はすべてUnixミリ秒

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  email TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE user_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX user_identities_provider_subject ON user_identities (provider, subject);
CREATE INDEX user_identities_user_id ON user_identities (user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_user_id ON sessions (user_id);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  replaced_by TEXT
);
CREATE UNIQUE INDEX refresh_tokens_token_hash ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_id ON refresh_tokens (session_id);

CREATE TABLE oauth_transactions (
  state_hash TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_transactions_expires_at ON oauth_transactions (expires_at);

CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_codes_expires_at ON login_codes (expires_at);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX outbox_unprocessed ON outbox (processed_at, created_at);
