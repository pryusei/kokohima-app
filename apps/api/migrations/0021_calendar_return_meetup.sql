-- T-57 成立した予定から Google カレンダーに入れる（docs/specs/T-57-meetup-google-calendar.md の「データ」）

-- 連携の開始で受け取った予定の ID（UUID として検証済み）。コールバックの戻り先 /meetups/<id> だけに使う。
-- 外部キーは付けない（予定が消えても、行は作成から10分で掃除される）
ALTER TABLE calendar_oauth_states ADD COLUMN return_meetup_id TEXT;
