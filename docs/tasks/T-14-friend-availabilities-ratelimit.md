# T-14 「みんな」の空きの回数の上限と、残るリスクの見直しの記録

## 目的
重い読み取りの `GET /friend-availabilities` を、1人の利用者が連打して D1 と CPU を使い切れないようにする。あわせて、セキュリティの見直しで挙がった2件（リンクのプレビューの DNS rebinding、認証の経路の回数の上限）を、変えない判断と理由とともに記録する。

## 関係する要件
- 要求定義書「サービス拒否」：送信上限とレート制限
- NF-09：有料プランの CPU 時間の上限を踏まえる
- docs/specs/T-10-idempotency-cache-ratelimit.md「回数の上限を付ける経路」（決定事項4・5）
- docs/specs/T-08-link-preview.md「名前解決の検査」（決定事項2）

## スコープ
- やること：
  - `GET /api/v1/friend-availabilities` に、利用者IDごとの回数の上限（`RL_USER`）を付ける
  - 「みんな」の画面で、429 のときに取り直さず、静かに待ってもらう
  - DNS rebinding と認証の経路の上限について、見直した結果（変えない）を仕様書に記録する
- やらないこと（スコープ外）：
  - `GET /friends/{friendId}/availabilities`（友達1人分）への上限
  - 認証の経路（`/auth/refresh`・`/auth/complete`・各コールバック）への上限
  - リンクのプレビューの取得の仕組みの変更
  - 「みんな」の検索そのものの軽量化（全件を展開してからページに分ける作り）

## 受け入れ条件
- [ ] 同じ利用者が `GET /friend-availabilities` を60秒に20回を超えて呼ぶと、429 `rate_limited`（`Retry-After: 60`）が返る
- [ ] 別の利用者の回数には影響しない。ほかの経路（`free_slots` など）の回数とも別に数える
- [ ] 「みんな」の画面は、429 のとき取り直さない。前に読めた内容があれば出したまま、なければ静かな文言を出す（エラー色を使わない）
- [ ] 他人のIDでは取得・更新できないテストがある（API の追加はなし。既存のテストが通ること）
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る（対象の流れはなし。既存のE2Eが通る）
- [ ] 仕様書とコードに齟齬がない（T-03・T-10 の仕様書の該当箇所を実装PRで書き換える）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-14-friend-availabilities-ratelimit.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 関係するスキル：`api-conventions`（エラー形式）、`data-fetching`（TanStack Query）、`invitation-domain`（用語）
