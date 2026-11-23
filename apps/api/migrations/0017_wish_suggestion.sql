-- T-29 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md「データ」）
-- 回数を数えるための記録だけ。入力の言葉・エリア・候補は持たない（決めたこと9）
-- user_id は退会で NULL にする（行は消さない）。サービス全体の1日の上限を、退会とログインし直しで戻せないようにするため

CREATE TABLE wish_suggestion_attempts (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'found', 'empty', 'failed')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
-- 1人の上限（利用者のタイムゾーンの今日）
CREATE INDEX wish_suggestion_attempts_user_created ON wish_suggestion_attempts (user_id, created_at);
-- 全体の上限（UTC の今日）と掃除（T-17）
CREATE INDEX wish_suggestion_attempts_created ON wish_suggestion_attempts (created_at);
