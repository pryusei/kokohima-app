# T-10 冪等キー・キャッシュ・回数の上限の基盤

## 目的
作成と状態遷移の `POST` のうち二重に実行すると結果が変わるものを、通信が切れたあとの押し直しや再送で二重に実行しないようにする（`Idempotency-Key`）。あわせて、読み取りの多い外部の結果のキャッシュと、認証なしの経路・外部を呼ぶ経路の回数の上限を、共通の仕組みとして用意する。T-08（OGP）はこの上に作る。

## 関係する要件
- NF-03：二重処理の防止（再送や二重押しで二重に実行しない）
- 要求定義書「サービス拒否」：送信上限とレート制限、外部APIの上限とバックオフ
- 要求定義書「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」（T-08 の前提）
- `api-conventions` スキル「冪等性」（作成と状態遷移の `POST` は `Idempotency-Key` を受け付ける）
- issue：pryusei/kokohima-app#40（KV の基盤）、pryusei/kokohima-app#54 の残り（認証なしの経路の上限、`ics-links` の発行数の上限）、pryusei/kokohima-app#42 のうちアプリの中で行う回数の上限

## スコープ
- やること：
  - `Idempotency-Key` の共通の仕組み（D1 に24時間保存）と、対象の `POST` への適用、Web の付け方
  - KV のバインディング（`CACHE`）と、キャッシュの共通の関数。最初の利用者は `GET /calendar/free-slots` の Google の埋まり
  - Workers の Rate Limiting のバインディングと、ログインの開始・招待リンクの確認・.ics・カレンダーの空きの回数の上限（レート制限。429 `rate_limited`）
  - `ics-links` の発行数の上限（D1 で数える、厳密な上限）
  - `api-conventions` スキルの「冪等性」の保存先を D1 に直す
- やらないこと（スコープ外）：
  - OGP の取得・キャッシュ・画像（T-08）
  - WAF のマネージドルール、HSTS・CSP、利用料アラート（エッジのセキュリティのタスク。pryusei/kokohima-app#42）
  - `sessions`・`refresh_tokens` の掃除（pryusei/kokohima-app#38 とあわせて別に行う）
  - Terraform の apply、wrangler deploy（人が行う）

## 受け入れ条件
- [ ] 同じ `Idempotency-Key` で同じ `POST` を2回送ると、2回目は1回目と同じ状態コード・本文を返し、2回目の処理は行われない
- [ ] 同じキーで本文が違うと422 `idempotency_key_mismatch`、1回目が処理中なら409 `request_in_progress`
- [ ] 別の利用者が同じキーを送っても衝突しない
- [ ] 招待リンクの確認・カレンダーの空きが、上限を超えると429 `rate_limited`（`Retry-After` 付き）になる。.ics は本文なしの429、ログインの開始はログイン画面の失敗へのリダイレクトになる
- [ ] 招待トークンや .ics のトークンを含む応答を保存しない
- [ ] 429 を受けた画面で、静かな文言を出す
- [ ] `ics-links` の発行が、利用者ごとの上限を超えると429になる
- [ ] `free-slots` を続けて開いても、Google の freeBusy を毎回は呼ばない（連携の解除・失効の後は使わない）
- [ ] 他人のIDでは取得・更新できないテストがある（冪等キーの再送で他人の結果を返さない）
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-10-idempotency-cache-ratelimit.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 画面：docs/design/
- 関係するスキル：api-conventions、new-api-endpoint、infra-change、data-fetching、calendar-integration
