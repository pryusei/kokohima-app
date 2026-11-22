-- T-16 退会（docs/specs/T-16-withdrawal.md「データ」）。利用者の行は ID だけの抜け殻として残す
-- withdrawn_at：退会した時刻（NULL なら利用中）。withdrawal_completed_at：後始末の段が終わった時刻
ALTER TABLE users ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE users ADD COLUMN withdrawal_completed_at INTEGER;
