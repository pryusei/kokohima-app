-- T-03 ここ暇（docs/specs/T-03-availability.md の「データ」）。日時はUnixミリ秒、現地の時刻は0時からの分

-- 行がなければ初期値（昼11:00〜15:00、夕方16:00〜19:00、夜19:00〜23:00）
CREATE TABLE presets (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_start INTEGER NOT NULL,
  day_end INTEGER NOT NULL,
  evening_start INTEGER NOT NULL,
  evening_end INTEGER NOT NULL,
  night_start INTEGER NOT NULL,
  night_end INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE availabilities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX availabilities_user_starts ON availabilities (user_id, starts_at, id);
CREATE INDEX availabilities_starts ON availabilities (starts_at);

CREATE TABLE recurrence_rules (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  label TEXT,
  timezone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX recurrence_rules_user ON recurrence_rules (user_id);

CREATE TABLE recurrence_exceptions (
  rule_id TEXT NOT NULL REFERENCES recurrence_rules(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, local_date)
);
