# T-10 仕様書：冪等キー・キャッシュ・回数の上限の基盤

- 状態：下書き
- タスク票：docs/tasks/T-10-idempotency-cache-ratelimit.md
- 関係する要件：NF-02、要求定義書「サービス拒否」（送信上限とレート制限、外部APIの上限）、「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」、`api-conventions` スキル「冪等性」。issue pryusei/kokohima-app#40、#54 の残り、#42 のうちアプリの中で行う上限

## 概要
- 作成と状態遷移の `POST` で `Idempotency-Key` を受け付け、同じキーの再送には1回目の結果をそのまま返す。T-02〜T-06 で先送りしていた規約を、共通の仕組みとして作る。
- 読み取りの多い外部の結果を KV にキャッシュする共通の関数を用意する。最初の利用者は `GET /calendar/free-slots` の Google の埋まり（T-06 で先送りしたもの）。T-08 の OGP もこれを使う。
- 認証なしの経路と外部を呼ぶ経路に、Workers の Rate Limiting で回数の上限を付ける。厳密な上限が要るものは、今までどおり D1 で数える。

## 前提

### 部品の役割（決定事項1）
公式のドキュメントで確かめた性質に合わせて、部品を使い分ける。

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| `Idempotency-Key` | D1 | 「処理中なら409」と「同じキーは1回だけ」には、書いた値がすぐ読めることと、不可分な操作が要る |
| 利用者ごとの厳密な上限（`ics-links` の発行数など） | D1 | 同上。誘いの送信上限（T-04）と同じ書き方 |
| 外部の結果のキャッシュ（free-slots の埋まり、T-08 の OGP） | KV | 読み取りが多く、少し古くてもよい |
| 経路ごとのおおよその上限（認証なしの経路、外部を呼ぶ経路） | Workers の Rate Limiting | 拠点ごとのおおよその数え方で足りる。D1 に書き込みを増やさない |

- 公式で確かめたこと（2026-11-17）：
  - KV は、書いた値がほかの拠点で見えるまで60秒以上かかることがある（eventually consistent）。公式は「不可分な操作や、1つの取引で読み書きする用途には向かない」と書いている。
  - KV の書き込みは、同じキーに1秒に1回まで。無料プランでは、別のキーへの書き込みが1日1,000回まで。1回の呼び出しの操作は1,000回まで。キーは512バイト、`cacheTtl` は30秒以上。
  - Rate Limiting のバインディングは、拠点ごとのおおよその数え方で、数え終わるまでは上限を超えることがある。周期は10秒か60秒。wrangler 4.36.0 以上（このリポジトリは 4.161）。
  - Rate Limiting の公式は、IP アドレスをキーにすることを勧めていない（多くの人で共有されるため）。そのため、認証のある経路は利用者 ID をキーにし、IP は認証なしの経路にだけ使い、上限をゆるくする（決定事項4）。
  - 厳密な上限が要るなら、公式は Durable Objects を勧めている。このタスクでは使わず、D1 で数える。
- `api-conventions` スキルの「KVに24時間保存」は、実装PRで「D1に24時間保存」に直す。

### コンテキストの分担
- 冪等キー・キャッシュ・回数の上限は、どのコンテキストにも属さない共通の仕組みとして `apps/api/src/shared/` と `apps/api/src/http/`（Hono の middleware）に置く。
- 各コンテキストの domain からは使わない（domain は Cloudflare・D1・Hono を import しない）。

## API
新しい経路は作らない。既存の経路の入力と応答を次のように変える。

### `Idempotency-Key` を受け付ける経路（決定事項2）
| 経路 | 仕様書 |
| --- | --- |
| `POST /api/v1/invite-links`、`POST /api/v1/invite-links/accept`、`POST /api/v1/invite-links/{id}/revoke` | T-02 |
| `POST /api/v1/availabilities`、`POST /api/v1/recurrence-rules`、`POST /api/v1/recurrence-rules/{id}/exceptions` | T-03 |
| `POST /api/v1/direct-invites`、`POST /api/v1/direct-invites/{id}/responses`、`POST /api/v1/direct-invites/{id}/decide`、`POST /api/v1/meetups/{id}/cancel` | T-04 |
| `POST /api/v1/broadcasts`、`POST /api/v1/broadcasts/{id}/responses`、`POST /api/v1/broadcasts/{id}/decide` | T-05 |

- 受け付けない経路（今までどおり）：認証（T-01）、`POST /notifications/read`・`POST /push/subscriptions`（何度送っても同じ。T-07）、`POST /calendar/google/authorizations`・`POST /meetups/{id}/ics-links`（何度やり直しても害がない。T-06）、`POST /invite-links/lookup`（読み取り）。
- ヘッダーは任意。付いていなければ今までどおり処理する（古いクライアントと E2E を壊さない）。
- 値は UUID（`z.uuid()`）。違えば400 `validation_failed`。

### 回数の上限を付ける経路（決定事項4・5）
| 経路 | キー | 上限（拠点ごと、おおよそ） | 仕組み |
| --- | --- | --- | --- |
| `GET /api/v1/auth/{google,apple}/start`、`GET /api/v1/auth/google/callback`、`POST /api/v1/auth/apple/callback`、`POST /api/v1/auth/complete` | IP（`CF-Connecting-IP`）と経路のまとまり | 60秒に30回 | Rate Limiting（`RL_PUBLIC`） |
| `POST /api/v1/invite-links/lookup` | IP と経路 | 60秒に30回 | Rate Limiting（`RL_PUBLIC`） |
| `GET /api/v1/ics/{token}` | IP と経路 | 60秒に30回 | Rate Limiting（`RL_PUBLIC`） |
| `GET /api/v1/calendar/free-slots`、`POST /api/v1/calendar/google/authorizations` | 利用者 ID と経路 | 60秒に20回 | Rate Limiting（`RL_USER`） |
| `POST /api/v1/meetups/{id}/ics-links` | 利用者 ID | 直近5分で20本（厳密） | D1（`ics_tokens` の行の数） |

- `POST /auth/refresh` には付けない（ページを開くたびに呼ばれ、失敗するとログアウトに見えるため。更新用トークンの交換そのものが1回限り）。
- 超えたら429 `rate_limited`、`Retry-After` は Rate Limiting なら `60`、`ics-links` なら最も古い行が5分を過ぎるまでの秒数（切り上げ）。
- 認証なしの経路の IP の上限は、学校・会社・携帯の回線で多くの人が同じ IP になることを考えて、ふつうの使い方では届かない値にする（決定事項4）。

### 出力・例外（共通）
| 場合 | 状態 | `type` |
| --- | --- | --- |
| 同じキー・同じ内容の再送で、1回目が終わっている | 1回目と同じ状態・本文・`Location` | （1回目のもの） |
| 同じキーで、メソッド・経路・本文のどれかが違う | 422 | `idempotency_key_mismatch` |
| 同じキーの1回目がまだ処理中 | 409 | `request_in_progress` |
| `Idempotency-Key` が UUID でない | 400 | `validation_failed` |
| 回数の上限を超えた | 429（`Retry-After`） | `rate_limited` |

- 再送で返した応答には `Idempotent-Replayed: true` を付ける（画面では使わない。調査のため）。
- エラーの本文は `api-conventions` の Problem Details の形。理由の細かい違い（どの上限か）は返さない。

## データ

### `idempotency_keys`（マイグレーション `0008_idempotency.sql`）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `user_id` | TEXT | → users（CASCADE）。キーは利用者ごと |
| `key` | TEXT | クライアントの UUID |
| `request_hash` | TEXT | メソッド・経路（パスの ID を含む）・本文の SHA-256（base64url） |
| `state` | TEXT | `in_progress`・`done` |
| `status` | INTEGER | 1回目の状態コード（`done` のとき） |
| `body` | TEXT | 1回目の本文（`done` のとき。なければ NULL） |
| `location` | TEXT | 1回目の `Location`（あれば） |
| `created_at` | INTEGER | 作った時刻（Unixミリ秒） |
| `expires_at` | INTEGER | `created_at + 24時間` |

- PK は `(user_id, key)`。
- 本文には、誘いの相手の表示名などが入ることがある。本人の行としてだけ読み、24時間で消す（決定事項3）。
- 掃除：outbox の Cron（`cleanupExpired`）で、`expires_at` を過ぎた行を消す。

### `ics_tokens`（T-06。変更なし）
- 発行数の上限は、閲覧者の `ics_tokens` のうち `created_at` が直近5分の行の数で数える。列は今のまま使う。
- 今あるインデックスは `created_at` だけなので、`0008_idempotency.sql` で `(user_id, created_at)` のインデックスを足す。

### KV（`CACHE`）
- Terraform の `kokohima-<env>-cache`（定義済み）を、wrangler の `kv_namespaces` に `CACHE` としてつなぐ。ID は Terraform の出力 `kv_namespace_id` を転記する（D1 と同じ手順。転記は人が行う。`infra-change` スキル）。
- キーは `<用途>:v1:<中身>` の形で、用途ごとに分ける。値は JSON。
- 置いてよいのは、外部から取ったもののうち、空き／埋まりの時刻や公開されているページの情報だけ。トークン・メールアドレス・誘いの中身は置かない。

## 振る舞い

### `Idempotency-Key`
1. 経路の middleware（認証の後）で、ヘッダーがあれば検証し、`request_hash` を作る。
2. `INSERT OR IGNORE INTO idempotency_keys (... state = 'in_progress' ...)` で予約する。
   - 入った（`changes = 1`）：処理を続ける。
   - 入らなかった：既存の行を読む。
     - `expires_at` を過ぎている：消してから2をやり直す（1回だけ）。
     - `request_hash` が違う：422。
     - `in_progress`：409。
     - `done`：保存した状態・本文・`Location` を返す。
3. 処理が終わったら、応答によって次のようにする。
   - 2xx・4xx：`state = 'done'` と応答を `WHERE state = 'in_progress'` の条件付き UPDATE で書く。4xx も保存するのは、同じ再送に同じ答えを返すため（Stripe などと同じ扱い）。
   - 5xx・例外：行を消す（クライアントがやり直せるように）。
4. 処理中のまま残った行（Worker が途中で止まった）は、作成から60秒を過ぎたら「処理中」とみなさず、消してやり直してよいものにする。60秒は Workers の1回の処理の時間より十分長い。
- 冪等の判定は、各経路の今の重複の判定（T-04 の同じ相手・同じ時刻の誘い、条件付き UPDATE の遷移）に重ねるもので、置き換えない。
- 保存する本文の大きさは64KB まで。超える応答は保存せずに行を消し、再送は通常の処理に任せる（今ある経路の応答はどれも小さい）。

### Web
- 対象の `POST` を送るとき、ボタンを押した1回の操作ごとに `crypto.randomUUID()` でキーを作り、同じ操作の再試行には同じキーを使う（`apiSend` に `idempotencyKey` を渡せるようにする）。
- TanStack Query の mutation は再試行しない設定のまま（今のまま）。キーは、通信が切れたあとに利用者がもう一度押したときではなく、APIクライアントが401のあとに1回だけ送り直すとき（T-01）に効く。もう一度押したときは新しいキーにする（新しい操作として扱う）。

### キャッシュ（KV）
- 共通の関数 `cached(env, key, ttlSeconds, load)`：KV にあれば返し、なければ `load()` の結果を書いてから返す。
  - `load()` が失敗したら書かない。
  - KV の読み書きの失敗は無視して `load()` の結果を使う（キャッシュがなくても動く）。
- free-slots（T-06）
  - Google の freeBusy の埋まり（開始・終了の配列）だけを、`freebusy:v1:<利用者ID>:<範囲の開始>:<範囲の終了>` に5分（`expirationTtl: 300`）置く。
  - 候補の計算（ここ暇と重ならない時間帯）は毎回行う。そのため、ここ暇を作った・消した直後でも候補はすぐ変わる。
  - 連携の解除・失効（`needs_reauth`）の後は使わない：読む前に連携の状態を確かめ、`active` でなければ KV を見ない。KV の値は5分で消える。
  - 埋まりは時刻だけで、予定の中身は入らない（CLAUDE.md「空き／埋まりのみ」）。

### 回数の上限
- Rate Limiting のバインディングを2つ持つ（`RL_PUBLIC`：60秒に30回、`RL_USER`：60秒に20回）。キーは `<経路のまとまり>:<IP か利用者ID>`。
- IP は `CF-Connecting-IP` を使う。なければ（ローカル・テスト）`unknown` にまとめる。
- ログに IP と利用者 ID を出さない。出すのは経路のまとまりと「上限を超えた」ことだけ。
- `ics-links`：閲覧者の直近5分の `ics_tokens` が20本以上なら429。数える文と発行する文は別でよい（上限を1本程度超えることは受け入れる。トークンは5分で切れるため）。
- テストと E2E：Rate Limiting のバインディングは、`AppDeps` の `rateLimiter` で差し替えられるようにする。ローカルの wrangler dev とテストの実行環境で、バインディングがどう動くかは実装の最初に確かめ、仕様書に書く。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `CACHE` | KV | `kokohima-<env>-cache`。ID は Terraform の出力を転記（TODO） |
| `RL_PUBLIC` | Rate Limiting | `namespace_id` はアカウントの中で一意の整数（環境ごとに分ける）。`simple: { limit: 30, period: 60 }` |
| `RL_USER` | Rate Limiting | 同上。`simple: { limit: 20, period: 60 }` |

## 認可と秘匿
- 閲覧者IDの使い方：`idempotency_keys` は必ず `user_id = 閲覧者` で読み書きする。別の利用者が同じキーを送っても、別の行になる。
- 他人のデータに届かないことの保証：再送で返すのは、閲覧者自身の行に保存した、閲覧者自身への応答だけ。他人の ID のキーで他人の応答は返らない（テストする）。
- 区別させない応答：
  - 冪等の再送は1回目と同じ応答なので、新しい区別は生まれない。
  - 429 は理由を分けない。誘いの送信上限（T-04）の429とも形が同じ。
  - 認証なしの経路の429は、相手のアカウントや招待リンクがあるかどうかに関係なく、回数だけで決まる。
- ログ：キーの値、本文、IP、利用者 ID を出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 冪等：同じキー・同じ内容の再送は、1回目と同じ状態・本文・`Location` を返し、処理（誘いの作成・outbox の行）は1回だけ。`Idempotent-Replayed: true` が付く。
- [ ] 冪等：同じキーで本文・経路・パスの ID が違うと422。
- [ ] 冪等：1回目が処理中なら409。60秒を過ぎた処理中の行はやり直せる。
- [ ] 冪等：4xx も保存して同じ答えを返す。5xx・例外のあとは同じキーでやり直せる。
- [ ] 冪等：24時間を過ぎた行は使わず、Cron で消える。
- [ ] 冪等：ヘッダーがなければ今までどおり。UUID でなければ400。
- [ ] 他人のIDでは取得できない：別の利用者が同じキーを送ると、別の処理として実行され、1回目の人の応答は返らない。
- [ ] 対象の経路すべてで受け付け、対象外の経路では無視する（表のとおり）。
- [ ] 上限：`RL_PUBLIC`・`RL_USER` が失敗を返すと429 `rate_limited`・`Retry-After: 60`。キーに経路のまとまりと IP（または利用者 ID）が入る。`/auth/refresh` には付かない。
- [ ] 上限：`ics-links` は直近5分で20本まで。21本めは429で、`Retry-After` が最も古い行が5分を過ぎるまでの秒数。
- [ ] キャッシュ：free-slots を5分以内に続けて開くと freeBusy を1回だけ呼ぶ。ここ暇を作った直後は候補が変わる。解除・失効の後はキャッシュを使わない。KV の失敗でも候補を返す。
- [ ] ログ：キー・本文・IP・利用者 ID が出ない。
- [ ] Web：対象の `POST` に `Idempotency-Key` を付け、401 のあとの送り直しでは同じキーを使う。

### E2Eテスト（対象にする利用者の流れ）
- 新しい利用者の流れはない（画面の動きは変わらない）。既存の E2E がすべて通ることを確かめる。
- E2E のサーバーでは上限を実質なしにする（`AppDeps` の差し替え）。並んで走るテストが同じ IP（`unknown`）になるため。

## スコープ外
- OGP の取得・キャッシュ・画像（T-08）。
- WAF のマネージドルール・IP 単位のエッジのレート制限、HSTS・CSP、利用料アラート（エッジのセキュリティのタスク。pryusei/kokohima-app#42）。
- `sessions`・`refresh_tokens` の掃除（pryusei/kokohima-app#38）。
- Durable Objects による厳密な上限。
- 冪等キーの Web 以外のクライアント（ネイティブアプリなど）。

## 決定事項（仕様書PRのレビューで合意する）
1. 部品は役割で分ける（実装の前に利用者に確かめた）：冪等と厳密な上限は D1、キャッシュは KV、経路ごとのおおよその上限は Workers の Rate Limiting。`api-conventions` の「KVに24時間保存」は D1 に直す。
2. `Idempotency-Key` を受け付けるのは「API」の表の経路だけ。ヘッダーは任意。（提案）
3. 4xx の応答も保存して同じ答えを返す。本文は本人の行として24時間だけ持つ。（提案）
4. 認証なしの経路は IP（`CF-Connecting-IP`）、認証のある経路は利用者 ID をキーにする。IP の上限は、共有の回線を考えてゆるくする（60秒に30回）。（提案）
5. `ics-links` の発行数は、直近5分で20本まで（D1 で数える）。（提案）
6. free-slots のキャッシュは Google の埋まりだけを5分。候補の計算は毎回行う。（提案）

## 確認事項（合意前に解消する）
- 上限の値（30回・20回・20本）は、ふつうの使い方で届かないかを見て決めた仮の値。運用で見直す。
- Rate Limiting の `namespace_id` の値の決め方（環境ごとに分ける番号）を、レビューで決める。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-17 | 初版 | pryusei/kokohima-app#40 の組み直し（KV の性質を公式で確かめ、役割で分けることを利用者と決めた） |
