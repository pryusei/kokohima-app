# T-30 公式のXとInstagram（Claude Code が案を作り、マージで予約し、Worker が自動で投稿する）

## 目的
ここ暇の公式アカウントを X と Instagram に置き、毎日の投稿を自動で回す。案（文と画像）は Claude Code が毎朝作って PR にし、開発者がマージすると予約になり、予約の時刻に専用の Worker が各 API で投稿する。開発者の毎日の作業は PR を見てマージすることだけにする。

## 関係する要件
- NF-01（Workers・D1・Cron）、NF-03（条件付き更新で二重処理を防ぐ）、NF-04（認証情報は Secrets の鍵で暗号化して保存する）、NF-05（ドメイン層は純粋）
- セキュリティ設計：開発・運営アカウントの保護（多要素認証・トークンを用途ごとに分ける）、外に出ている窓口を一覧にし使わないルートは閉じる、ログに秘密情報を出さない
- 概要の「収益：当面は無料。広告は入れない」（公式アカウントは広告を出さず、ここ暇のお知らせと使い方だけを出す）

## スコープ
- やること：
  - 投稿をファイルで持つ形（`marketing/posts/`）と、その検査（Zod のスキーマ、文字数、画像、URL の禁止）
  - 画像を作るテンプレート（`marketing/templates/`）と、Playwright で JPEG に書き出すスクリプト
  - 投稿の専用の Worker（`apps/sns`、`kokohima-sns`）：5分ごとに GitHub の `main` から今日の投稿を読み、予約の時刻に X と Instagram に投稿する。結果を Slack に出す
  - Instagram の画像を渡す公開の URL（`https://sns.kokohima.app/media/<token>.jpg`。投稿している間だけ開く）
  - Instagram のトークンの自動の更新（D1 に暗号化して持つ）
  - 止める仕組み（`marketing/sns.yaml` の `paused`）と、staging の空撃ち（`SNS_DRY_RUN`）
  - Claude Code のスキル（`.claude/skills/sns-posting/`）と、毎朝の案を作るスケジュールのタスク
  - D1（`kokohima-<env>-sns`）の Terraform、wrangler の設定、手順書（`docs/runbooks/sns.md`）
  - マーケティングのファイルだけの PR で E2E の手順を飛ばす（必須のチェックは残す）
- やらないこと（スコープ外）：
  - アカウントの作成・開発者の登録・トークンの発行（規約で自動化できないので人が行う）
  - 返信・いいね・フォロー・DM の自動化
  - 反応の数（表示回数・いいね）の集計と、それを使った案の改善（次のタスク）
  - リール・ストーリーズ・動画、X のスレッドと引用
  - アプリの利用者のデータを使った投稿（人数・成立数を含む）

## 受け入れ条件
- [ ] `marketing/posts/` に投稿のファイルを足した PR を `main` にマージすると、予約の時刻（過ぎていればすぐ）に X・Instagram に1回だけ出て、Slack に投稿の URL が届く
- [ ] 22時（JST）までにマージされなかった投稿は出ず、Slack に「出しませんでした」と届く
- [ ] 出る前にファイルを消す PR をマージすると、出ない
- [ ] 5分ごとの Cron が重なっても、同じ投稿が2回出ない
- [ ] 検査に通らない投稿のファイル（文字数の超過、X の本文の URL、画像の大きさの違い、日付とパスの食い違い）は CI で落ちる
- [ ] `marketing/sns.yaml` を `paused: true` にしてマージすると、次の投稿から出なくなる
- [ ] staging（`SNS_DRY_RUN=1`）では X・Instagram の API を呼ばない
- [ ] 画像の URL は、その投稿を出している間だけ開き、それ以外は404になる
- [ ] Instagram のトークンが期限の前に自動で更新される。更新できないときは Slack に届く
- [ ] SNS の Worker は、アプリの D1・KV・R2 にバインディングを持たない
- [ ] トークン・Webhook の URL・API の応答の本文がログと Slack に出ない
- [ ] 毎朝のスケジュールのタスクが、その日の投稿の案の PR を作る
- [ ] 単体テストが追加され、通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-30-official-sns.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 関係するスキル：infra-change、d1-migration、api-conventions（画像の経路だけ）、calendar-integration（トークンの暗号化の形）
- 似た仕組み：docs/specs/T-24-contact.md（Slack への送り方）、docs/specs/T-06-calendar.md（トークンの暗号化・更新）、docs/specs/T-13-monitoring.md（Workers Issues）、docs/specs/T-12-release.md（本番の設定の検査）
