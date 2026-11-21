-- T-13 監視とアラート（docs/specs/T-13-monitoring.md の「データ」）。定期処理が最後に終わりまで動いた時刻（Unixミリ秒）
CREATE TABLE cron_runs (
  name TEXT PRIMARY KEY NOT NULL,
  last_run_at INTEGER NOT NULL
);
-- デプロイの直後に、まだ動いていないだけで死活確認が 503 にならないよう、適用した時刻で入れておく
INSERT INTO cron_runs (name, last_run_at) VALUES
  ('minutely', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('calendar_sync', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
