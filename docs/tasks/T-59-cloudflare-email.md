# T-59 メールの送信を Cloudflare Email Service に移す

## 目的
今 Resend で送っているメール（T-07 のお知らせのメール、新しい端末でのログインの知らせ、T-23 の HTML のメール）を、Workers の `send_email` バインディングで送る Cloudflare Email Service に移す。外部の事業者と秘密情報（`RESEND_API_KEY`）を1つずつ減らす（持ち主の依頼）。

## 関係する要件
- NF-01・NF-02・NF-07、技術選定の「メール配信」
- 仕様書：docs/specs/T-59-cloudflare-email.md
- T-07（docs/specs/T-07-notification.md）、T-23（docs/specs/T-23-rich-mail.md）、T-12（docs/specs/T-12-release.md）、T-13（docs/runbooks/monitoring.md）、T-16（docs/specs/T-16-withdrawal.md）、T-19（docs/specs/T-19-privacy-terms.md）

## スコープ
- やること：
  - ① 送る口を1つにし、Resend と Cloudflare の実装を `MAIL_PROVIDER` で切り替える。全環境に `send_email` のバインディング `EMAIL`（prod は差出人を `notify@kokohima.app` に絞る）。全環境は Resend のまま。単体テスト
  - ② `dns.tf` に Cloudflare の送信の記録（`cf-bounce` の MX・SPF・DKIM）を `import` で取り込む（持ち主がドメインを登録したあと）
  - ③ prod とコードの既定を Cloudflare にする。プライバシー ポリシーの5.の Cloudflare に「メールの配信」。要求定義書を直す
  - ④ Resend のコード・`RESEND_API_KEY`・DNS の記録・ポリシーの記述・仕様書の記述を外す
- やらないこと（スコープ外）：
  - バウンス・苦情のイベントをアプリで受けること、メールの受信
  - メールの中身・送る条件・1日の上限の数の変更
  - staging のデプロイ、BIMI（T-51）

## 受け入れ条件
- [ ] メールが Cloudflare Email Service で送られ、差出人・中身・上限が今のまま
- [ ] 一時的な失敗は再試行、1日の枠は `limited`、ほかは `failed`。ログに宛先・件名・本文が出ない
- [ ] DNS の記録が Terraform で持たれ、DMARC が消えて作り直されない
- [ ] 持ち主が Gmail・iCloud・Outlook・キャリアのメールで届くことを確かめた
- [ ] プライバシー ポリシーと仕様書・要求定義書が実際と一致する
- [ ] 他人のIDでは取得できない（API を足さないので既存のテストのまま）
- [ ] 単体テストが追加され、通る
- [ ] typecheck・lint・関係するテスト・本番のビルドが通る

## 仕様書
- docs/specs/T-59-cloudflare-email.md

## 参考
- 関係するスキル：infra-change
- 人が行う作業：送信ドメインの登録、「Email preview」を切る、届くかの確認、`terraform apply`・`wrangler deploy`、Resend の片付け（仕様書「人が行う作業」）
