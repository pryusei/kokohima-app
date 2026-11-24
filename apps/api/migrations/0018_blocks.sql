-- T-33 ブロック（docs/specs/T-33-block-report.md「データ」）。日時はUnixミリ秒
-- 1行で「blocker_id が blocked_id をブロックしている」。どちらの向きの行でも、招待リンクでつながらない
-- 行はブロックをやめたとき・どちらかが退会したときに消す（T-16。users の行は退会でも残るので CASCADE には頼らない）
-- 通報は表を作らず、outbox の UserReported の行だけを使う（T-24 の問い合わせと同じ）

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
-- 一覧（ブロックした新しい順）
CREATE INDEX blocks_blocker_created ON blocks (blocker_id, created_at, blocked_id);
-- 逆の向きの確かめ（招待リンク）と退会での削除
CREATE INDEX blocks_blocked ON blocks (blocked_id, blocker_id);
