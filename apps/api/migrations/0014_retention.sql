-- T-17 古いデータの掃除と保持期間（docs/specs/T-17-retention.md「データ」）
-- dormant_since：休眠にした時刻（NULL なら休眠でない）。休眠中は定期の確認に割り当てない
ALTER TABLE calendar_connections ADD COLUMN dormant_since INTEGER;

-- 毎分の掃除が表全体を読まないためのインデックス
CREATE INDEX direct_invites_ends ON direct_invites (ends_at);
CREATE INDEX broadcasts_ends ON broadcasts (ends_at);
CREATE INDEX invite_links_expires ON invite_links (expires_at);
CREATE INDEX recurrence_exceptions_date ON recurrence_exceptions (local_date);
-- 予定を消すときの CASCADE の子の検索（ほかの子の列は UNIQUE か主キーで、すでにインデックスがある）
CREATE INDEX ics_tokens_meetup ON ics_tokens (meetup_id);

-- 定期の確認の割り当て：status と dormant_since の等しい条件で範囲を絞り、last_synced_at の順に読む
DROP INDEX calendar_connections_sync;
CREATE INDEX calendar_connections_sync ON calendar_connections (status, dormant_since, last_synced_at);

-- 今ある、友達でない相手との「見せる」の公開設定の行を消す（1回だけ）。「見せない」の行は消さない
DELETE FROM sharing_policies
WHERE visible = 1
  AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = sharing_policies.owner_id AND f.friend_id = sharing_policies.target_id)
  AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = sharing_policies.target_id AND f.friend_id = sharing_policies.owner_id);
