-- T-35 通知の見え方を本人が選ぶ（docs/specs/T-35-notification-visibility.md の「データ」）

-- ロック画面に出す中身。hidden：種類だけ（初期値）／detailed：相手の名前と日時も
ALTER TABLE notification_preferences ADD COLUMN lock_screen TEXT NOT NULL DEFAULT 'hidden';

-- プッシュの暗号化の鍵（RFC 8291 の p256dh と auth）。endpoint と同じく暗号化して保存する。
-- 鍵のない購読（T-35 より前に登録した購読）には、本文のないプッシュを送る
ALTER TABLE push_subscriptions ADD COLUMN keys_enc TEXT;
