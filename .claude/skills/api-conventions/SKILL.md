---
name: api-conventions
description: APIの全体共通ルール（パス、メソッド、ID、日時とタイムゾーン、ページング、エラー形式、ステータスコード、冪等性、スキーマの置き場所）。APIの追加・変更、APIクライアントの実装、仕様書のAPI欄を書くときに読む
---
# APIの共通ルール

## パスとメソッド
- ベースは `/api/v1`。パスはkebab-case、リソースは複数形、名前は用語表に合わせる
  - 例：`/availabilities`、`/recurrence-rules`、`/direct-invites`、`/broadcasts`、`/meetups`、`/friends`、`/invite-links`、`/me`
- 取得は `GET`、作成は `POST`、部分更新は `PATCH`、削除は `DELETE`
- 状態遷移は `PATCH` で status を書き換えず、動詞のサブリソースへの `POST` にする
  - 例：`POST /direct-invites/{id}/responses`（行く／今回は難しい／この時間なら）、`POST /broadcasts/{id}/decide`、`POST /meetups/{id}/cancel`
- JSONのプロパティはcamelCase。列挙値は小文字のsnake_case（例：`"pending"`、`"counter_proposed"`）

## ID
- 外に出すIDは `crypto.randomUUID()` のUUID（v4）。連番やDBの内部IDを外に出さない
- 招待リンクのトークンはIDとは別に、32バイトのランダム値をbase64urlで表し、D1にはハッシュだけを保存する

## 日時とタイムゾーン
- APIの日時はISO 8601のUTC（`2026-10-10T02:00:00Z`）。D1にはUnixミリ秒の整数で保存する
- ユーザーはIANAのタイムゾーン（初期値 `Asia/Tokyo`）を持つ。表示はクライアントがユーザーのタイムゾーンで行う
- ここ暇の枠は開始・終了の瞬間（UTC）で保存する。時間帯プリセットの境界とくり返しのルールは、ユーザーのタイムゾーンの「現地の時刻」で保存し、展開するときにUTCへ変換する
- 期間の指定は `from`・`to`（ISO 8601、`from` を含み `to` を含まない）
- 夏時間などで現地の時刻がずれる日は、次のように丸める（JavaScriptのTemporalの `disambiguation: "compatible"` と同じ）
  - 存在しない時刻（時計が進む日の 2:30 など）：ずれた分だけ後ろにずらす（2:30 → 3:30）
  - 二重に存在する時刻（時計が戻る日の 1:30 など）：早いほう（1回目）を使う
  - 変換後に終了が開始以前になった枠は作らない

## レスポンスの形
- 1件はリソースのオブジェクトをそのまま返す。`{ data: ... }` のような包みはしない
- 一覧は `{ "items": [...], "nextCursor": "..." | null }`
- 値がないときは項目を省かず `null` を入れる。条件によって項目の有無が変わると、見せない設定や応答者の有無を推測できてしまうため
- 他人の情報は公開プロフィール（`id`、`displayName`、`avatarUrl`）だけを返す。メールアドレスなどは返さない

## ページング
- カーソル方式：`?limit=20&cursor=...`。`limit` の上限は50、既定は20
- カーソルはサーバーが作る不透明な文字列（base64url）。クライアントは中身を解釈しない
- 並び順は必ず一意に決まるようにする。最後の比較キーに `id` を入れて同順位をなくし、カーソルには並び順のキーの値（例：作成日時と `id`）を入れる
  - 既定：作成日時の新しい順、同じなら `id` の降順（受信・送信した誘い、通知など）
  - 時間の流れで見る一覧：開始日時の古い順、同じなら `id` の昇順（ここ暇、成立した予定など）
  - これ以外の並び順にする場合は、仕様書のAPI欄に並び順のキーを書く
- 並び順のキーにはD1のインデックスを用意する

## エラー
- RFC 9457（Problem Details）の形で、`Content-Type: application/problem+json` で返す
  ```json
  { "type": "about:blank", "title": "Validation failed", "status": 400,
    "code": "validation_failed", "requestId": "...",
    "errors": [{ "path": "message", "code": "too_long" }] }
  ```
- 画面の文言は、クライアントが `code` から決める。サーバーの `title`・`detail` をそのまま表示しない
- `detail` に個人情報、内部の値、スタックトレースを入れない

| 状況 | ステータス | code |
| --- | --- | --- |
| 入力が不正 | 400 | `validation_failed` |
| 未認証・トークン切れ | 401 | `unauthenticated` |
| 存在しない・権限がない・見せない設定 | **404（すべて同じ）** | `not_found` |
| 状態遷移できない（返答済み、決定済みなど） | 409 | `invalid_state` |
| 期限切れ | 409 | `expired` |
| 冪等キーの使い回し（本文が違う） | 422 | `idempotency_key_mismatch` |
| 同じ冪等キーの処理が実行中 | 409 | `request_in_progress` |
| 送信上限・レート制限 | 429（`Retry-After` を付ける） | `rate_limited` |
| 想定外 | 500 | `internal_error` |

- `invalid_state` と `expired` の使い分け
  - `invalid_state`：利用者やシステムの操作で状態が変わったために、もう実行できない（返答済み、決定済み、キャンセル済み、自動で断った後など）
  - `expired`：状態は変わっていないが、時間の経過で失効した（返事の期限、招待リンクの有効期限など）
  - 判定はこの順に行う：先に状態を確認し、状態が変わっていれば `invalid_state`。状態がそのままで期限を過ぎているときだけ `expired`
- IMPORTANT: 権限がない場合に403を返さない。存在の有無を漏らさないため、すべて404の `not_found` にする

## 成功時のステータス
- 作成は201と `Location` ヘッダー、更新・取得は200、本文のない削除・取り消しは204

## 冪等性
- 作成と状態遷移の `POST` は `Idempotency-Key` ヘッダー（UUID）を受け付ける。同じキーの再送は、最初の結果をそのまま返す（KVに24時間保存）
- キーは利用者ごとに扱う（別の利用者が同じキーを送っても衝突させない）
- 最初のリクエストのメソッド・パス・本文のハッシュを一緒に保存し、同じキーで内容が違うリクエストが来たら422の `idempotency_key_mismatch` で拒否する
- 同じキーの最初のリクエストがまだ処理中なら、409の `request_in_progress` を返す
- クライアントは楽観的更新の再試行や二重押しに備えて、操作ごとにキーを付ける

## 認証
- `Authorization: Bearer <アクセストークン>`。更新は `POST /api/v1/auth/refresh`（更新用トークンのCookieとOriginヘッダーで検証）

## スキーマと型
- リクエストとレスポンスの両方のZodスキーマを `packages/shared/src/schemas/<context>.ts` に置き、型は `z.infer` で作る
- APIはリクエストを検証してから処理し、クライアントはレスポンスを検証してから使う
- 文字列には必ず上限を付ける（ひとこと、エリア、表示名、URLなど。値は仕様書で決める）

## 追跡
- すべてのレスポンスに `X-Request-Id` を付け、エラーの本文にも `requestId` を入れる。ログはこのIDで追い、個人情報は残さない

## バージョン
- 互換性を壊す変更は原則しない。どうしても必要なら `/api/v2` を作り、`v1` との並行期間を仕様書に書く
