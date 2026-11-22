-- 定期処理が動いた記録（docs/specs/T-13-monitoring.md「定期処理が動いた記録」）。深い死活確認（/api/v1/health/ready）で読む
-- 行は2つのままで増えない。個人情報は入らない
CREATE TABLE cron_runs (
  name TEXT PRIMARY KEY NOT NULL,
  last_run_at INTEGER NOT NULL
);
-- デプロイの直後に、まだ動いていないだけで 503 にならないよう、適用した時刻で入れておく（ミリ秒）
INSERT INTO cron_runs (name, last_run_at) VALUES
  ('minutely', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('calendar_sync', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
