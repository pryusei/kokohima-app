-- 失効・期限切れのセッションと更新用トークンの掃除（docs/specs/T-01-auth.md「データ」、issue #54）のインデックス
CREATE INDEX sessions_revoked_at ON sessions (revoked_at);
CREATE INDEX sessions_expires_at ON sessions (expires_at);
CREATE INDEX sessions_user_created ON sessions (user_id, created_at, id);
CREATE INDEX refresh_tokens_expires_at ON refresh_tokens (expires_at);
