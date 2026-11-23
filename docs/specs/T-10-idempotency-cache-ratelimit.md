# T-10 仕様書：冪等キー・キャッシュ・回数の上限（レート制限）の基盤

- 状態：実装済み
- タスク票：docs/tasks/T-10-idempotency-cache-ratelimit.md
- 関係する要件：NF-03（二重処理の防止）、要求定義書「サービス拒否」（送信上限とレート制限、外部APIの上限）、「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」、`api-conventions` スキル「冪等性」。issue pryusei/kokohima-app#40、#54 の残り、#42 のうちアプリの中で行う上限

## 概要
- 作成と状態遷移の `POST` のうち、二重に実行すると結果が変わるものだけで `Idempotency-Key` を受け付け、同じキーの再送には1回目の結果をそのまま返す。T-02〜T-06 で先送りしていた規約を、共通の仕組みとして作る。
- 読み取りの多い外部の結果を KV にキャッシュする共通の関数を用意する。最初の利用者は `GET /calendar/free-slots` の Google の埋まり（T-06 で先送りしたもの）。T-08 の OGP は、結果の保存が要件で同時の取得を防ぐのに強い整合性が要るので、KV を使わず D1 の行で兼ねる（docs/specs/T-08-link-preview.md 決定事項4）。
- 認証なしで書き込みを起こす経路（ログインの開始）、認証なしでトークンを当てずっぽうに試せる経路（招待リンクの確認・.ics）、外部を呼ぶ経路（カレンダーの空き）に、Workers の Rate Limiting で回数の上限（レート制限）を付ける。厳密な上限が要るものは、今までどおり D1 で数える。

## 前提

### 部品の役割（決定事項1）
公式のドキュメントで確かめた性質に合わせて、部品を使い分ける。

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| `Idempotency-Key` | D1 | 「処理中なら409」と「同じキーは1回だけ」には、書いた値がすぐ読めることと、不可分な操作が要る |
| 利用者ごとの厳密な上限（`ics-links` の発行数など） | D1 | 同上。誘いの送信上限（T-04）と同じ書き方 |
| 外部の結果のキャッシュ（free-slots の埋まり） | KV | 読み取りが多く、少し古くてもよい（T-08 の OGP は D1。T-08 決定事項4） |
| 経路ごとのおおよその上限 | Workers の Rate Limiting | 拠点ごとのおおよその数え方で足りる。D1 に書き込みを増やさない |

- 公式で確かめたこと（2026-11-17）：
  - KV は、書いた値がほかの拠点で見えるまで60秒以上かかることがある（eventually consistent）。公式は「不可分な操作や、1つの取引で読み書きする用途には向かない」と書いている。
  - KV の書き込みは、同じキーに1秒に1回まで。1回の呼び出しの操作は1,000回まで。キーは512バイト、`cacheTtl` は30秒以上。無料プランでは、別のキーへの書き込みが1日1,000回までだが、このサービスは有料プランが前提（NF-09）。
  - Rate Limiting のバインディングは、拠点ごとのおおよその数え方で、数え終わるまでは上限を超えることがある。周期は10秒か60秒。wrangler 4.36.0 以上（このリポジトリは 4.161）。
  - Rate Limiting の公式は、IP アドレスをキーにすることを勧めていない（多くの人で共有されるため）。そのため、認証のある経路は利用者 ID をキーにし、IP は認証なしの経路にだけ使い、上限をゆるくする（決定事項4）。
  - 厳密な上限が要るなら、公式は Durable Objects を勧めている。このタスクでは使わず、D1 で数える。

### コンテキストの分担
- 冪等キー・キャッシュ・回数の上限は、どのコンテキストにも属さない共通の仕組みとして `apps/api/src/shared/` と `apps/api/src/http/`（Hono の middleware）に置く。
- 各コンテキストの domain からは使わない（domain は Cloudflare・D1・Hono を import しない）。

### 実装PRで直すもの
- `api-conventions` スキルの「冪等性」：保存先を「D1に24時間」にし、対象を「二重に実行すると結果が変わる作成・状態遷移の `POST`」にする。保存しない応答（下記）も書く。
- 要求定義書：構成図の「KV キャッシュ・レート制限」を「KV キャッシュ」と「Rate Limiting」に分ける。残りの論点「外部API呼び出しの上限・バックオフ」「その他のレート制限の値」の進み具合を更新する。

## API
新しい経路は作らない。既存の経路の入力と応答を変えるだけなので、テンプレートの経路の表ではなく、変わる点ごとの表で書く。

### `Idempotency-Key` を受け付ける経路（決定事項2）
| 経路 | 仕様書 |
| --- | --- |
| `POST /api/v1/availabilities`、`POST /api/v1/recurrence-rules` | T-03 |
| `POST /api/v1/direct-invites`、`POST /api/v1/direct-invites/{id}/responses`、`POST /api/v1/direct-invites/{id}/decide`、`POST /api/v1/meetups/{id}/cancel` | T-04 |
| `POST /api/v1/broadcasts`、`POST /api/v1/broadcasts/{id}/decide` | T-05 |
| `POST /api/v1/wishes` | T-22 |
| `POST /api/v1/contact-messages`（本文の上限（8KiB）を `idempotent` より前に置く。大きな本文を読んでハッシュを作り、行を作らないため） | T-24 |

- 受け付けない経路と理由：
  - 応答に秘密値が入る：`POST /invite-links`（招待トークン）、`POST /meetups/{id}/ics-links`（.ics のトークン）。保存すると D1 に平文が残るため。二重に作っても、無効化と期限で害がない。
  - 何度送っても結果が同じ：`POST /invite-links/{id}/revoke`（T-02）、`POST /broadcasts/{id}/responses`（T-05）、`POST /recurrence-rules/{id}/exceptions`（T-03）、`POST /notifications/read`・`POST /push/subscriptions`（T-07）、`POST /calendar/google/authorizations`（T-06）。
  - Cookie で結果が決まる：`POST /invite-links/accept`（招待 Cookie を消費する。再送は404 で害がない。T-02）。
  - 認証（T-01）と読み取り（`POST /invite-links/lookup`）。
  - 退会 `POST /me/withdrawal`（T-16）。2回目はセッションがないので401になり、何も変わらない。
- ヘッダーは任意。付いていなければ今までどおり処理する（古いクライアントと E2E を壊さない）。
- 値は UUID（`z.uuid()`）。違えば400 `validation_failed`。

### 回数の上限を付ける経路（決定事項4・5）
| 経路 | まとまりの名前 | キー | 上限 | 仕組み | 超えたとき |
| --- | --- | --- | --- | --- | --- |
| `GET /api/v1/auth/{google,apple}/start` | `auth_start` | IP | 60秒に30回（拠点ごと、おおよそ） | `RL_PUBLIC` | 303：`/login?error=login_failed`（T-01 の失敗と同じ） |
| `POST /api/v1/invite-links/lookup` | `invite_lookup` | IP | 同上 | `RL_PUBLIC` | 429 `rate_limited` |
| `GET /api/v1/ics/{token}` | `ics` | IP | 同上 | `RL_PUBLIC` | 429（本文なし。OS のカレンダーが開く経路のため） |
| `GET /api/v1/calendar/free-slots` | `free_slots` | 利用者 ID | 60秒に20回（拠点ごと、おおよそ） | `RL_USER` | 429 `rate_limited` |
| `GET /api/v1/friend-availabilities` | `friend_availabilities` | 利用者 ID | 60秒に20回（拠点ごと、おおよそ） | `RL_USER` | 429 `rate_limited`（T-14） |
| `GET /api/v1/friend-wishes` | `friend_wishes` | 利用者 ID | 60秒に20回（拠点ごと、おおよそ） | `RL_USER` | 429 `rate_limited`（T-22） |
| `GET /api/v1/link-previews/images/{imageId}` | `link_image` | IP | 60秒に30回（拠点ごと、おおよそ） | `RL_PUBLIC` | 429（本文なし。`<img>` が読む経路のため。T-08） |
| `GET /api/v1/health/ready` | `health_ready` | IP | 60秒に30回（拠点ごと、おおよそ） | `RL_PUBLIC` | 429 `rate_limited`（T-13） |
| `POST /api/v1/meetups/{id}/ics-links` | — | 利用者 ID | 直近5分で20本（厳密） | D1（`ics_tokens` の行の数） | 429 `rate_limited` |
| `POST /api/v1/contact-messages` | `contact_messages`（ログの `group`） | 利用者 ID | 直近24時間で3件（厳密） | D1（outbox の `ContactMessageSubmitted` の行の数） | 429 `rate_limited`（T-24） |

- 付けない経路と理由：
  - `GET /auth/google/callback`・`POST /auth/apple/callback`・`POST /auth/complete`・`GET /calendar/google/callback`：どれも1回限りの値（state・完了コード）を消費するので、連打しても書き込みは増えない。経路をまとめて数えると、同じ回線の他人が軽い経路の連打で、ほかの人のログインを止められるため。
  - `POST /auth/refresh`：ページを開くたびに呼ばれ、失敗するとログアウトに見えるため。更新用トークンの交換そのものが1回限り（T-01）。
  - `POST /calendar/google/authorizations`：T-06 の D1 の上限（10分に10回）があるので、重ねない。
- 429 の `Retry-After`：Rate Limiting なら `60`。`ics-links` なら、最も古い行が5分を過ぎるまでの秒数（切り上げ）。`contact-messages` なら、同じ時刻で数え直した最も古い行が24時間を過ぎるまでの秒数（切り上げ。1以上。読めなければ1。T-24）。
- 認証なしの経路の IP の上限は、学校・会社・携帯の回線で多くの人が同じ IP になることを考えて、ふつうの使い方では届かない値にする（決定事項4）。

### 出力・例外（共通）
| 場合 | 状態 | `code` |
| --- | --- | --- |
| 同じキー・同じ内容の再送で、1回目が終わっている | 1回目と同じ状態・本文・`Location`・`Content-Type` | （1回目のもの） |
| 同じキーで、メソッド・経路・本文のどれかが違う | 422 | `idempotency_key_mismatch` |
| 同じキーの1回目がまだ処理中 | 409 | `request_in_progress` |
| `Idempotency-Key` が UUID でない | 400 | `validation_failed` |
| 回数の上限を超えた | 429（`Retry-After`）。`auth_start` だけは303 | `rate_limited` |

- 再送で返した応答には、`Idempotent-Replayed: true` と `Cache-Control: no-store` を付ける（画面では使わない）。
- エラーの本文は `api-conventions` の Problem Details の形。どの上限かは返さない。

## データ

### `idempotency_keys`（マイグレーション `0008_idempotency_ratelimit.sql`）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `user_id` | TEXT | → users（CASCADE）。キーは利用者ごと |
| `key` | TEXT | クライアントの UUID |
| `reservation_id` | TEXT | 予約ごとの乱数。書き戻しと削除を、自分の予約だけに限るため |
| `request_hash` | TEXT | メソッド・経路（パスの ID を含む）・本文の SHA-256（base64url） |
| `state` | TEXT | `in_progress`・`done` |
| `status` | INTEGER | 1回目の状態コード（`done` のとき） |
| `content_type` | TEXT | 1回目の `Content-Type`（`done` のとき） |
| `body` | TEXT | 1回目の本文（`done` のとき。なければ NULL） |
| `location` | TEXT | 1回目の `Location`（あれば） |
| `created_at` | INTEGER | 予約した時刻（Unixミリ秒） |
| `expires_at` | INTEGER | `created_at + 24時間` |

- PK は `(user_id, key)`。`expires_at` のインデックスを足す（掃除のため）。
- 本文には、誘いの相手の表示名などが入ることがある。本人の行としてだけ読み、24時間で消す（決定事項3）。
- 掃除：outbox の Cron（`cleanupExpired`）で、`expires_at` を過ぎた行を消す。

### `ics_tokens`（T-06）
- 発行数の上限は、閲覧者の `ics_tokens` のうち `created_at` が直近5分の行の数で数える。列は今のまま使う。
- 今あるインデックスは `created_at` だけなので、`0008_idempotency_ratelimit.sql` で `(user_id, created_at)` のインデックスを足す。

### KV（`CACHE`）
- Terraform の `kokohima-<env>-cache`（定義済み）を、wrangler の `kv_namespaces` に `CACHE` としてつなぐ。ID は Terraform の出力 `kv_namespace_id` を転記する（D1 と同じ手順。転記は人が行う。`infra-change` スキル）。
- キーは `<用途>:v1:<中身>` の形で、用途ごとに分ける。値は JSON。
- 置いてよいのは、外部から取ったもののうち、空き／埋まりの時刻や公開されているページの情報だけ。トークン・メールアドレス・誘いの中身は置かない。

## 振る舞い

### `Idempotency-Key`
1. 対象の経路ごとに、`requireAuth`（と `requireActiveSession`）の後に middleware を付ける。閲覧者がいなければ処理しない（fail closed）。ヘッダーがあれば検証し、`request_hash` を作る。
2. `INSERT OR IGNORE INTO idempotency_keys (... reservation_id = <新しい乱数>, state = 'in_progress' ...)` で予約する。
   - 入った（`changes = 1`）：処理を続ける。
   - 入らなかった：既存の行を読む。
     - `expires_at` を過ぎている、または `in_progress` のまま作成から5分を過ぎている：`WHERE user_id = ? AND key = ? AND reservation_id = <読んだ値>` の条件付き DELETE で消し、2をやり直す（1回だけ）。同時に来たほかのリクエストが新しく予約した行は消さない。
     - `request_hash` が違う：422。
     - `in_progress`：409。
     - `done`：保存した状態・本文・`Location`・`Content-Type` を返す。
3. 処理が終わったら、応答によって次のようにする。書き戻しと削除は、どれも `WHERE user_id = ? AND key = ? AND reservation_id = <自分の予約> AND state = 'in_progress'` の条件付き。
   - 2xx と、409・429 以外の 4xx：`state = 'done'` と応答を書く。4xx も保存するのは、同じ再送に同じ答えを返すため。
   - 409・429・5xx・例外：行を消す（クライアントがやり直せるように。429 の `Retry-After` を古い値で返さないため）。
4. 処理中を5分とみなすのは、どの経路も外部の呼び出しは5秒で打ち切り、残りは D1 の数回の読み書きだけのため。5分を過ぎて引き継がれたあとに1回目が終わっても、`reservation_id` が違うので書き戻さない。
- 受け入れること：
  - 業務の書き込みが終わったあと、`done` を書く前に Worker が止まると、同じキーの再送はもう一度実行される。各経路の今の重複の判定（T-04 の同じ相手・同じ時刻の誘い、条件付き UPDATE の状態遷移）に任せる。募集の作成（T-05）は同じ内容の重複を判定しないので、まれに2件できることがある。
  - 再送で返すのは、1回目に本人が受け取った応答と同じもの。そのあとに状態が変わっても（募集から抜けた、友達を解除したなど）、24時間は同じ応答を返す。本人がすでに受け取った内容なので受け入れる。
- 冪等の判定は、各経路の今の重複の判定に重ねるもので、置き換えない。
- 保存する本文の大きさは64KB まで。超える応答は保存せずに行を消し、再送は通常の処理に任せる（今ある経路の応答はどれも小さい）。

### Web
- 対象の `POST` を送るフォーム（作成画面・返事・決める・やっぱり難しい）は、1つの操作ごとにキーを持つ。
  - 最初に送るときに `crypto.randomUUID()` で作る。
  - 通信できなかった・5xx のあと、入力を変えずにもう一度押したときは、同じキーで送る（通信が切れて、サーバーでは1回目が終わっていた場合に、二重に作らないため）。
  - 4xx を受けたとき（保存された答えが24時間同じになるため）、入力を変えたとき、成功したときは、キーを捨てる（次は新しいキー）。
- `apiSend` に `idempotencyKey` を渡せるようにし、ヘッダーに付ける。401 のあとの1回だけの送り直し（T-01）でも同じキーを使う。
- `ApiError` に Problem Details の `code` を持たせる（今は `status` だけ）。
- 422 `idempotency_key_mismatch`・409 `request_in_progress` を受けたら、その画面の「もう一度お試しください」の文言を静かに出す（誘い・募集の作成は「送信できませんでした。もう一度お試しください」、ここ暇・くり返しの作成は「作れませんでした。もう一度お試しください。」、返事・決める・やっぱり難しい・候補からの作成は今の失敗の文言のまま）。409 `invalid_state` など、今の画面がすでに扱っている応答の扱いは変えない。

### キャッシュ（KV）
- 共通の関数 `cached(ctx, key, ttlSeconds, load)`：KV にあれば返し、なければ `load()` の結果を KV に書いてから返す。書き込みは待つ（`waitUntil` にしないのは、テストで書き込みの終わりを確かめられるようにするため。数ミリ秒の違い）。
  - `load()` が失敗したら書かない。
  - KV の読み書きの失敗は無視して `load()` の結果を使う（キャッシュがなくても動く）。
- free-slots（T-06）
  - Google の freeBusy の埋まり（開始・終了の配列）だけを、`freebusy:v1:<利用者ID>:<連携の connected_at>:<freeBusy の範囲の開始>:<終了>` に5分（`expirationTtl: 300`）置く。
    - 範囲は、実際に freeBusy に渡す範囲（プリセットの枠から作る範囲）。query の `from`・`to` ではない。プリセットを変えたら別のキーになる。
    - `connected_at` を入れるので、解除してつなぎ直したあと（別の Google アカウントでも）は、前の連携の埋まりを使わない。
  - 候補の計算（ここ暇と重ならない時間帯）は毎回行う。そのため、ここ暇を作った・消した直後でも候補はすぐ変わる。
  - 連携が `active` でなければ KV を見ない。
  - 受け入れること：Google に足した予定が、最大5分は候補に残る。
  - 埋まりは時刻だけで、予定の中身は入らない（CLAUDE.md「空き／埋まりのみ」）。
  - KV の書き込みの回数は、`free_slots` の上限（60秒に20回）で抑えられる。

### 回数の上限
- Rate Limiting のバインディングを2つ持つ（`RL_PUBLIC`：60秒に30回、`RL_USER`：60秒に20回）。キーは `<まとまりの名前>:<IP か利用者ID>`。
- IP は `CF-Connecting-IP` を使う（Cloudflare のエッジが付け直すので、外から差し替えられない）。
  - IPv4 はそのまま、IPv6 は /64 の接頭辞にまとめて数える（1つの回線が /64 を持てるので、アドレスごとに数えると上限を回避できる）。読めない値はヘッダーがないときと同じ扱い。
  - ヘッダーがなければ、上限をかけずに「ヘッダーがない」ことだけをログに出す（全員が1つの数え方にまとまって、ログインできなくなるのを防ぐ）。本番・staging・ローカル・テストで同じ扱い（ローカルの wrangler dev はヘッダーを付ける）。
- ログに IP と利用者 ID を出さない。出すのはまとまりの名前と「上限を超えた」ことだけ。
- `ics-links`：発行の文を `INSERT INTO ics_tokens ... SELECT ... WHERE (SELECT COUNT(*) FROM ics_tokens WHERE user_id = ? AND created_at > ?) < 20` の1つの文にする。入らなかったら429。同時に送っても上限を超えない（T-04 の送信上限と同じ書き方）。
- テストと E2E：Rate Limiting と KV は `AppDeps` で差し替えられるようにする。E2E の差し替えは `createWorker(overrides)` を通して `apps/api/src/e2e/entry.ts` からだけ行い、環境変数では切り替えない。
  - E2E では、上限を実質なしにし、`CACHE` を使わない（並んで走るテストが同じ回線になるため。偽の埋まりを途中で変えるテストがあるため）。
  - 確かめたこと（実装PR）：単体テストの実行環境（Miniflare）は wrangler の設定の `kv_namespaces`・`ratelimits` をそのまま使え、Rate Limiting も「60秒に30回」を超えると止まる。KV の期限（`expirationTtl`）は本物の時計で切れるので、テストでは期限の値を確かめる（偽の時計では切れない）。
  - 単体テストでは、上限の判定をテストの道具（`test/identity-harness.ts` の `limiter`）から差し替えられる。

### 画面（仮）
- 429 を受けたときは、赤を使わずに静かに出す。
  - 招待リンクの受け口：「混み合っています。少し待ってから、もう一度開いてください」
  - ここ暇タブの「カレンダーの空き」：候補を出さず、「少し待ってから、もう一度開いてください」
  - 「カレンダーに追加」：「少し待ってから、もう一度お試しください」
- ログイン（`auth_start` の上限）は、ログイン画面の今の `login_failed` の文言のまま。
- カレンダーの空きのクエリは、429 のあとは自動で取り直さない（取り直すと、さらに上限を使うため）。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `CACHE` | KV | `kokohima-<env>-cache`。ID は Terraform の出力を転記（TODO） |
| `RL_PUBLIC` | Rate Limiting | `namespace_id` はアカウントの中で一意の整数。`simple: { limit: 30, period: 60 }` |
| `RL_USER` | Rate Limiting | 同上。`simple: { limit: 20, period: 60 }` |

- `namespace_id`：ローカル 1001・1002、e2e 1101・1102、assets（T-12）1201・1202、staging 2001・2002、prod 3001・3002（`RL_PUBLIC`・`RL_USER` の順）。
- バインディングがない（設定の漏れ）・判定に失敗したときは、上限をかけずに `rate_limit_skipped` の記録を残す（キー・IP・利用者 ID は入れない）。おおよその上限なので、止めるより通す側に倒す。

- wrangler の各環境（既定のローカル・e2e・assets（T-12）・staging・prod）すべてに書く（T-06 の `JOBS` と同じ）。ローカルと e2e の KV の ID は、ローカルでだけ使う値でよい。

## 認可と秘匿
- 閲覧者IDの使い方：`idempotency_keys` は必ず `user_id = 閲覧者` で読み書きする。別の利用者が同じキーを送っても、別の行になる。middleware は閲覧者が決まってから動く（fail closed）。
- 他人のデータに届かないことの保証：再送で返すのは、閲覧者自身の行に保存した、閲覧者自身への応答だけ。他人と同じキーを送っても、他人の応答は返らない（対象の経路ごとにテストする）。キャッシュのキーにも利用者 ID と連携の `connected_at` を入れる。
- 秘密値：招待トークン・.ics のトークンを含む応答の経路は対象外にし、D1 にも KV にも平文を置かない。
- 区別させない応答：
  - 冪等の再送は1回目と同じ応答なので、新しい区別は生まれない。422・409 は自分のキーにしか起きない。
  - 429 は理由を分けない。誘いの送信上限（T-04）の429とも形が同じ。
  - 認証なしの経路の429は、相手のアカウントや招待リンクがあるかどうかに関係なく、回数だけで決まる。
- ログ：キーの値、本文、IP、利用者 ID を出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 冪等：同じキー・同じ内容の再送は、1回目と同じ状態・本文・`Location`・`Content-Type` を返し、処理（誘いの作成・outbox の行）は1回だけ。`Idempotent-Replayed: true` と `Cache-Control: no-store` が付く。
- [ ] 冪等：同じキーで本文・経路・パスの ID が違うと422。
- [ ] 冪等：1回目が処理中なら409。5分を過ぎた処理中の行は引き継げる。引き継がれたあとに1回目が終わっても、2回目の行を上書きしない。
- [ ] 冪等：同時の再送で、互いの新しい予約を消さない（削除が `reservation_id` の条件付き）。
- [ ] 冪等：4xx も保存して同じ答えを返す。409・429・5xx・例外は保存せず、同じキーでやり直せる。
- [ ] 冪等：24時間を過ぎた行は使わず、Cron で消える。
- [ ] 冪等：ヘッダーがなければ今までどおり。UUID でなければ400。
- [ ] 他人のIDでは取得できない：対象の経路ごとに、別の利用者が同じキーを送ると別の処理として実行され、1回目の人の応答は返らない。
- [ ] 対象外の経路（表のとおり）では、ヘッダーを無視する。`POST /invite-links` の応答の招待トークンが `idempotency_keys` に入らない。
- [ ] 上限：`RL_PUBLIC`・`RL_USER` が失敗を返すと429 `rate_limited`・`Retry-After: 60`。キーにまとまりの名前と IP（または利用者 ID）が入る。
- [ ] 上限：`auth_start` の上限超えは `/login?error=login_failed` への303。コールバック・`complete`・`refresh`・`authorizations` には付かない。
- [ ] 上限：`CF-Connecting-IP` がなければ（どの環境でも）上限をかけない。IPv6 は /64 にまとめる。バインディングがない・判定に失敗したときは、キーを出さずに記録を残して通す。
- [ ] 上限：`ics-links` は直近5分で20本まで。21本めは429で、`Retry-After` が最も古い行が5分を過ぎるまでの秒数。同時に送っても20本を超えない。
- [ ] キャッシュ：free-slots を5分以内に続けて開くと freeBusy を1回だけ呼ぶ。ここ暇を作った直後は候補が変わる。プリセットを変えると取り直す。
- [ ] キャッシュ：連携を解除してつなぎ直したあとは、前の連携の埋まりを使わない。別の利用者に、ほかの人の埋まりが返らない。KV の失敗でも候補を返す。
- [ ] ログ：キー・本文・IP・利用者 ID が出ない。
- [ ] Web：対象の `POST` に `Idempotency-Key` を付ける。通信できなかった・5xx のあとに入力を変えずにもう一度押すと同じキー、4xx・入力の変更・成功のあとは新しいキー。401 のあとの送り直しでは同じキー。
- [ ] Web：409 `invalid_state` など、今の画面の扱いが変わらない。409 `request_in_progress`・422 `idempotency_key_mismatch` だけ新しい文言になる。
- [ ] Web：429 を受けた画面（招待リンクの受け口・カレンダーの空き・カレンダーに追加）で、静かな文言を出す（赤やエラー色を使わない）。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 既存の E2E（ログイン、誘い〜成立、募集、カレンダー連携、通知）がすべて通る。画面の流れは変わらないので、新しい流れは足さない。E2E のサーバーでは上限を実質なしにし、`CACHE` を使わない。

## スコープ外
- OGP の取得・キャッシュ・画像（T-08）。
- WAF のマネージドルール・エッジのレート制限、HSTS・CSP、利用料アラート（エッジのセキュリティのタスク。pryusei/kokohima-app#42）。
- `sessions`・`refresh_tokens` の掃除（pryusei/kokohima-app#38）。
- Durable Objects による厳密な上限。
- 冪等キーの Web 以外のクライアント（ネイティブアプリなど）。

## 決定事項（仕様書PRのレビューで合意する）
1. 部品は役割で分ける（実装の前に利用者に確かめた）：冪等と厳密な上限は D1、キャッシュは KV、経路ごとのおおよその上限は Workers の Rate Limiting。T-08 の OGP の結果は、保存が要件で強い整合性が要るので、KV ではなく D1 に持つ（T-08 決定事項4。T-08 の仕様書PR pryusei/kokohima-app#75 で合意）。`api-conventions` の「KVに24時間保存」は D1 に直す。
2. `Idempotency-Key` を受け付けるのは、二重に実行すると結果が変わる「API」の表の経路だけ。秘密値を含む応答と、何度送っても結果が同じ経路は対象外。ヘッダーは任意。（提案）
3. 2xx と、409・429 以外の 4xx を保存して同じ答えを返す。本文は本人の行として24時間だけ持つ。処理中の行は5分で引き継げる。（提案）
4. 認証なしの経路は IP（`CF-Connecting-IP`）、認証のある経路は利用者 ID をキーにする。IP の上限は、共有の回線を考えてゆるくする（60秒に30回）。1回限りの値を消費する経路には付けない。（提案）
5. `ics-links` の発行数は、直近5分で20本まで（D1 の1つの文で数える）。（提案）
6. free-slots のキャッシュは Google の埋まりだけを5分。キーに連携の `connected_at` と実際の範囲を入れ、候補の計算は毎回行う。（提案）

## 確認事項（合意前に解消する）
- 上限の値（30回・20回・20本）は、ふつうの使い方で届かないかを見て決めた仮の値。運用で見直す（仕様書PRで合意）。
- Rate Limiting の `namespace_id` は、環境ごとに番号の千の位を分けた（「設定値」）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-17 | 初版 | pryusei/kokohima-app#40 の組み直し（KV の性質を公式で確かめ、役割で分けることを利用者と決めた） |
| 2026-11-17 | 冪等の対象から秘密値を含む応答と何度送っても同じ経路を外した。409・429 を保存しない、`reservation_id` で書き戻しと削除を自分の予約に限る、処理中は5分、Web は操作ごとにキーを持ち続ける、に直した。回数の上限を1回限りの値を消費しない経路に絞り、`auth_start` は303、`authorizations` は T-06 の上限のまま、`ics-links` は1つの文にした。キャッシュのキーに `connected_at` と実際の範囲を入れた。429 の画面、wrangler の環境、要件の参照（NF-03）を足した。既存の仕様書（T-01〜T-06）の先送りの記述を直した | 仕様書PRのレビュー（セキュリティ・仕様） |
| 2026-11-17 | 実装した。KV の書き込みは待つ形にした、`CF-Connecting-IP` がないときはどの環境でも上限をかけない、`ApiError` は `code` を持つ、カレンダーの空きのクエリは429のあと取り直さない、に直した。テストの実行環境で確かめたことを書いた | 実装PR |
| 2026-11-17 | 実装PRのレビューを反映：IPv6 は /64 にまとめて数える、バインディングがない・判定に失敗したときは記録を残して通す、`namespace_id` の番号、画面ごとの冪等キーの衝突の文言、429 のあとに取り直さないことを書いた | 実装PRのレビュー（セキュリティ・仕様） |
| 2026-11-21 | T-08 の OGP は KV を使わず D1 で兼ねることにした（概要・部品の役割・決定事項1）。回数の上限の表に `link_image` を足した | T-08 の決定事項4（pryusei/kokohima-app#75） |
| 2026-11-21 | 回数の上限の表に `friend_availabilities` を足した | T-14 の実装PR（docs/specs/T-14-friend-availabilities-ratelimit.md） |
| 2026-11-22 | 回数の上限の表に `health_ready` を足した（実装は T-13 で済んでいる） | T-13 の実装のあとのレビュー（docs/specs/T-13-monitoring.md） |
| 2026-11-23 | 冪等キーの表に `POST /wishes`、回数の上限の表に `friend_wishes` を足した | T-22 実装PR（docs/specs/T-22-wishlist.md） |
| 2026-11-23 | 冪等キーの表と回数の上限の表に `POST /contact-messages` を足した | T-24 実装PR（docs/specs/T-24-contact.md） |
