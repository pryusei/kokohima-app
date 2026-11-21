-- データの増加への備え（docs/specs/T-13-data-growth.md）。毎分の掃除が表全体を読まないためのインデックス
-- 期限切れの .ics のトークンの掃除（DELETE ... WHERE expires_at <= ?）
CREATE INDEX ics_tokens_expires ON ics_tokens (expires_at);
-- 古い日の数の掃除（DELETE ... WHERE day < ?）。主キー (user_id, day, channel) は先頭が user_id なので使えない
CREATE INDEX notification_daily_counts_day ON notification_daily_counts (day);
-- 古い結果の行の掃除（status と fetched_at・claimed_at で絞る）
CREATE INDEX link_previews_status_fetched ON link_previews (status, fetched_at);
CREATE INDEX link_previews_status_claimed ON link_previews (status, claimed_at);
