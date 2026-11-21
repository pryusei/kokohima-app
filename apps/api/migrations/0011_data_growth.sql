-- T-12 データの増加への備え（docs/specs/T-12-data-growth.md の「データ」）。毎分の掃除が表全体を読まないためのインデックス
CREATE INDEX ics_tokens_expires_at ON ics_tokens (expires_at);
CREATE INDEX notification_daily_counts_day ON notification_daily_counts (day);
CREATE INDEX link_previews_status_fetched ON link_previews (status, fetched_at);
CREATE INDEX link_previews_status_claimed ON link_previews (status, claimed_at);
