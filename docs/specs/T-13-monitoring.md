# T-13 仕様書：監視とアラート（ログの通知・死活監視・退避キューの調べ方）

- 状態：実装済み（実装PRマージ）
- タスク票：docs/tasks/T-13-monitoring.md
- 関係する要件：要求定義書「技術の選定」の監視、「AI時代の攻撃を前提にした運用」（異常のアラート）、「残りの論点」（異常検知のアラートの条件と通知先）、NF-02、NF-03
- 関係する issue：pryusei/kokohima-app#85。関連は #42（利用料アラート）、#41（監査ログ）、#52（本番までに人が行う作業）

## 概要
- いまのコードは、乗っ取りの疑い（`refresh_token_reuse`）・通知の失敗（`job_dead_lettered`）・想定外の例外（`unhandled_error`）などをログに出している。しかし、ログは Workers Logs に7日残るだけで、誰にも届かない。
- 定期処理（Cron）が止まっても、outbox が溜まっても、API が落ちても、知る手段がない。退避キューに入ったメッセージを調べる手順もない。
- この仕様書では、次の3つを決める。
  1. **ログの通知**：アラートにする条件と閾値を決め、Cloudflare の機能（Monitors・Workers Issues）で Slack に送る。
  2. **死活監視**：定期処理が動いた記録と、深い死活確認の API を足し、外の監視サービスから5分ごとに確かめる。
  3. **調べる手順**：退避キュー、問い合わせ、ログを見られる人の範囲を、手順書に書く。
- 利用者の画面と、既存の API の振る舞いは変えない。

## 全体の形

| 気づきたいこと | 気づく仕組み | 通知先 |
| --- | --- | --- |
| アプリが出したログ（下の「アラートの一覧」） | Cloudflare の Monitors（Workers Logs を決まった間隔で数える） | Slack |
| アプリのログを通らない失敗（捕まえていない例外、CPU 時間の超過、5xx） | Workers Issues と、その自動の通知（Automations） | Slack |
| Worker・D1 が落ちた、定期処理が止まった、outbox が溜まった | 外の監視サービスが `GET /api/v1/health/ready` と画面（`/`）を5分ごとに確かめる | メールと Slack |

- 「ログが出ないこと」（定期処理の停止）は、Monitors では検知できない（結果が0行の問い合わせは通知しない、と公式にある）。そのため、止まったことは死活確認の API の 503 として外から見る。
- Queues の溜まり具合・退避キューの件数は、Monitors の対象にない。outbox の滞留は D1 の行（未処理の最古の行）で見て、退避キューに入ったことはログ（`job_dead_lettered`）で見る。

### Cloudflare の機能について確かめたこと（2026-11-21、公式ドキュメント）
- Workers Logs 自体は残すだけで、保持は有料プランで7日。通知は Issues と Monitors で行う（https://developers.cloudflare.com/workers/observability/logs/workers-logs/）。
- Monitors：SQL の問い合わせを決まった間隔で実行し、結果が条件を満たすと通知する。通知先はメール・webhook・PagerDuty。設定は管理画面（Alerts > Monitors）。結果が0行のときは通知しない（https://developers.cloudflare.com/notifications/monitors/）。
- Workers Issues：捕まえていない例外・失敗した呼び出し・5xx・error の重さのログを、問題としてまとめる。オープンベータで、ベータの間は無料。wrangler の `observability.issues.enabled` で有効にする（wrangler 4.134.0 以上。設定に書かないと、次のデプロイで無効に戻る）。warn のログは対象にならない（https://developers.cloudflare.com/workers/observability/issues/）。
- Issues の自動の通知：「発生した数が閾値を超えたとき」と「しばらく止まっていた問題がまた起きたとき」に、webhook・チャットなどへ送る。設定は管理画面か Cloudflare の CLI（https://developers.cloudflare.com/workers/observability/issues/automations/）。
- 通知の webhook：すべてのプランで使える。Slack の Incoming Webhook の URL をそのまま登録できる（https://developers.cloudflare.com/notifications/get-started/configure-webhooks/）。
- Health Checks（Cloudflare 自身の死活監視）は、ゾーンが Pro 以上で使える。無料のゾーンでは使えない（https://developers.cloudflare.com/health-checks/）。
- 退避キュー：consumer のない退避キューのメッセージは、4日で消える。HTTP で読む consumer（`wrangler queues consumer http add`）を付けると、API で読める（https://developers.cloudflare.com/queues/configuration/dead-letter-queues/、https://developers.cloudflare.com/queues/configuration/pull-consumers/）。
- まだ確かめられていないことは「確認事項」に書く。

## API
`api-conventions` スキルのルールに従う。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/health/ready` | なし | なし | 200 `{ "status": "ok" }` | 503 `unavailable`、429 `rate_limited` |

- 既存の `GET /api/v1/health`（Worker が応答するかだけを見る）は変えない。
- 503 は Problem Details の形で返す。`code` は `unavailable`（新しく足す。`api-conventions` スキルの表に実装PRで追記する）。
  - 応答に、どの条件で落ちたか・時刻・件数を入れない。どの条件でも同じ本文にする。
- 回数の上限：IP ごとに `RL_PUBLIC`（1分に30回）を使う。グループ名は `health_ready`（T-10 の仕組み）。
- `Cache-Control: no-store` を付ける。

## データ
- マイグレーション `0012_cron_runs.sql`（T-12 の `0011_data_growth.sql` の次。実装の順番が変わったら番号を合わせる）で、表を1つ足す。

| 表 | 列 | 説明 |
| --- | --- | --- |
| `cron_runs` | `name` TEXT PRIMARY KEY | 定期処理の名前。`minutely`（毎分）・`calendar_sync`（15分ごと） |
| | `last_run_at` INTEGER NOT NULL | 最後に終わりまで動いた時刻（ほかの表と同じミリ秒） |

- マイグレーションの中で、2行を「適用した時刻」で入れておく。デプロイの直後に、まだ動いていないだけで 503 にならないようにするため。
- 個人情報は入らない。行は2つのままで増えない。

## 振る舞い

### 1. 定期処理が動いた記録
- `runScheduled` の最後に、その定期処理の行の `last_run_at` をいまの時刻にする（`INSERT ... ON CONFLICT(name) DO UPDATE`）。
  - 毎分の処理（outbox を流す・掃除）の後に `minutely`、15分ごとの割り当ての後に `calendar_sync`。
- 途中の処理が失敗していても記録する（T-12 で、各処理は独立し、失敗は `cron_step_failed` のログになる。処理の失敗はログで、定期処理そのものの停止はこの記録で見る）。
- 記録の書き込みも、T-12 の「独立した1つの処理」として扱う。失敗したら `{ event: "cron_step_failed", step: "heartbeat", name }` を出す。

### 2. 深い死活確認（`GET /api/v1/health/ready`）
- 次のどれかに当てはまれば 503、どれにも当てはまらなければ 200 を返す。

| 理由（ログの `reason`） | 条件 |
| --- | --- |
| `db` | D1 の読み取りが例外を投げた |
| `cron_minutely` | `cron_runs` の `minutely` の `last_run_at` が、5分より前（行がない場合も） |
| `cron_calendar_sync` | `calendar_sync` の `last_run_at` が、45分より前（行がない場合も。3回分の遅れ） |
| `outbox_backlog` | outbox の未処理の行のうち、いちばん古い `created_at` が10分より前 |

- 境界：ちょうど5分・45分・10分は 200（「より前」のときだけ 503）。
- outbox の滞留で見るのは、いま Queue に流す型（`dispatchedTypes`）の行だけ。流す型がまだない未処理の行は残り続けるので（T-12）、数えない。
  - 既存のインデックス `outbox_unprocessed (processed_at, created_at)` で読む。
- 503 のときは、理由だけのログを1行出す：`{ event: "health_degraded", reason }`。複数に当てはまるときは、表の上から最初の1つ。
- 読むだけで、何も書かない。認証は要らない。利用者のデータには触れない。

### 3. ログの追加と、重さの見直し
- 同じ1件の失敗が、Monitors と Workers Issues の両方から通知されないように、ログの重さで受け持ちを分ける。Workers Issues は error の重さのログと 5xx を問題として扱うため、何もしないと二重に届く。
  - **Monitors が受け持つログ（`event` で数えるもの）は、warn 以下で出す。** Issues には上がらない。
    - `job_failed`・`job_dead_lettered` を、`console.error` から `console.warn` に変える。項目（`kind`・`type`・`id`・`attempts`・`error`）は変えない。
    - `cron_step_failed`（T-12）は `console.warn` で出す。
    - `refresh_token_reuse`（warn）・`calendar_decrypt_failed`（log）などは、いまのまま。
  - **error で出すログは、Workers Issues が受け持つ。** Monitors は作らない。
    - `unhandled_error`：`console.error` のまま。応答が 500 になるので、ログの重さを変えても Issues に上がる。Issues の側に任せる。
    - `calendar_connect_failed`（`reason: "unexpected"`）：`console.error` のまま。
  - これから足すログも、この分け方に従う（`event` で数えて通知したいものは warn 以下、想定外の例外は error）。
  - Issues の自動の通知に、対象を絞る条件があるかは確かめられていない。ログの重さで分けるので、絞れなくても二重にならない。
- サービス全体の1日のメール数の上限（`MAIL_DAILY_LIMIT`、T-07 決定事項8）で送らなかったとき、ログを出す：`{ event: "notification_mail_global_limit", kind }`。
  - `kind` はお知らせの種類だけ。宛先・利用者IDは出さない。利用者ごとの上限（`limited`）では出さない。
- ほかのログの名前と項目は変えない。ログの書き方（1行の JSON、`event` で種類を表す）も変えない。
  - Monitors では、ログの本文（`$metadata.message`）が `"event":"<名前>"` を含むことで絞る（JSON の文字列が項目に分かれて読めるかは公式で確かめられなかったため。下の「実装PRで確かめたこと」）。ログの書き方は変えない。
- wrangler の設定に `observability.issues.enabled: true` を足す（トップレベルと prod）。`invocation_logs: false`（T-06）は変えない。

### 4. アラートの一覧
- 通知先は Slack の2つのチャンネルに分ける。どちらも非公開のチャンネルにする。
  - `#kokohima-alerts`（すぐ見る）：スマホの通知をオンにする。
  - `#kokohima-notices`（気づけばよい）：通知はオフでよい。1日1回見る。
- Monitors は、本番の Worker の Workers Logs を対象に、`event` ごとに件数を数える。同じ条件が続く間の再通知は1時間ごと（既定）。
- 閾値は、友達だけ（100人まで）の運用を前提にした最初の値。運用で見直し、変えたらこの表と手順書を直す。

**すぐ見る（`#kokohima-alerts`）**

| 見るもの | 条件 | 意味と、最初にすること |
| --- | --- | --- |
| `refresh_token_reuse` | 15分に1件以上 | 更新用トークンの再利用。盗用の疑い。そのセッションは失効済み。同じ時間帯の `login_failed`・`rate_limited` を見る |
| `job_dead_lettered` | 15分に1件以上 | 通知・カレンダーの書き込みなどが再試行を使い切った。「退避キューの調べ方」へ |
| `cron_step_failed` | 15分に3件以上 | 定期処理の同じ失敗が続いている。`step` を見る |
| `calendar_decrypt_failed` | 15分に1件以上 | カレンダーの認証情報を復号できない。鍵の設定を確かめる |
| Workers Issues | 新しい問題が1回起きた／24時間止まっていた問題がまた起きた | API の想定外の例外（`unhandled_error`。`requestId` と例外の名前でログを引く）と、アプリのログを通らない失敗（捕まえていない例外、CPU 時間の超過など） |
| 外からの死活確認 | `/api/v1/health/ready` か `/` が、2回続けて失敗 | Worker・D1 の障害、定期処理の停止、outbox の滞留。`health_degraded` の `reason` を見る |

**気づけばよい（`#kokohima-notices`）**

| 見るもの | 条件 | 意味 |
| --- | --- | --- |
| `outbox_dispatch_capped` | 1時間に1件以上 | outbox を流す量が上限に達した（T-12）。上限の見直し |
| `calendar_sync_assign_full` | 1時間に1件以上 | カレンダーの確認の割り当てが上限で埋まった（T-12） |
| `rate_limited` | 15分に50件以上 | 回数の上限の超過が多い。悪用か、上限の設定が低すぎるか |
| `login_failed` | 15分に20件以上 | ログインの失敗が多い |
| `rate_limit_skipped`（`reason` が `no_binding`・`error`） | 1時間に1件以上 | 回数の上限が効いていない。設定の誤り |
| `notification_push_rejected` | 1時間に10件以上 | プッシュの送り先に拒否されている |
| `notification_mail_rejected` | 1時間に10件以上 | メールの配信サービスに拒否されている |
| `notification_mail_global_limit` | 1時間に1件以上 | サービス全体の1日のメール数の上限に達した |
| `calendar_sync_held` | 1時間に5件以上 | カレンダーの大きな変化での保留が多い（T-06） |

- 通知の中身：Monitors の通知は、モニターの名前と数だけにする。モニターの名前に、個人を表す値を入れない。ログの本文（`sessionId` など）は Slack に流さず、Cloudflare の管理画面で見る。
- Workers Issues の通知には、例外の要約が入る。個人情報が入りうるかは、設定するときに実際の通知で確かめる（「確認事項」）。
- Workers Issues の問題の詳細と通知に、リクエストの URL（パス・クエリ）が入るかも確かめる。URL にトークンが入る経路（OAuth のコールバックの `code`、`.ics` のパス）があり、そのために呼び出しのログを切っているため（T-06 決定事項14）。Slack への自動の通知を作る前に、管理画面の問題の詳細で確かめる。入るなら、Slack への通知は作らず、`unhandled_error` の Monitors を足す。管理画面に URL が残ることを受け入れるか、Issues を無効に戻すかは、この仕様書を直して決める。手順は手順書「1-4.」。
- 上の表で、Monitors（`event` の行）と Workers Issues の対象は重ならない（「3.」のログの重さの分け方）。同じ1件で2通は届かない。

### 5. 外からの死活監視
- 外の監視サービスは、Better Stack（Uptime）の無料の枠を使う。
  - 選んだ理由：無料の枠で、Slack とメールの両方に通知できる見込みで、確認の間隔が3分（仕様の「5分ごと」より短い）。必要な監視は2つで、無料の枠の数に収まる。
  - 確認の間隔は、無料の枠で選べるいちばん短いもの（3分）にする。5分より長くしない。
  - 無料の枠は個人のプロジェクト向け。一般公開して収益化するときは、有料の枠か別のサービスに見直す。
  - 確かめる URL：`https://kokohima.app/api/v1/health/ready`（200 であること）、`https://kokohima.app/`（200 であること）。`kokohima.app` は、T-12（Web としての最初のリリースの準備）で決めた本番のドメイン。wrangler の設定の仮の値は、T-12 の実装で置き換わる。
  - 2回続けて失敗したら通知し、戻ったときも通知する。
  - 通知先は、メール（開発者本人）と `#kokohima-alerts`。Slack 自体が止まっていても気づけるよう、メールを必ず入れる。
- サービスには URL のほかに何も渡さない（認証情報を渡さない）。Slack への通知は、Better Stack の Slack 連携か、`#kokohima-alerts` の Incoming Webhook で行う。
- Better Stack のアカウントは開発者本人だけが持ち、2段階認証を有効にする。

### 6. 設定の置き場所（インフラのコード管理の例外）
- Monitors・Issues の自動の通知・通知先の webhook は、Cloudflare の管理画面で人が設定する。Terraform では管理しない。
  - 理由：Monitors と Issues の自動の通知を Terraform で書けるかは、公式ドキュメントで確かめられなかった。Slack の webhook の URL は秘密情報で、Terraform の変数や状態ファイルに入れたくない（`infra/README.md`「秘密情報は `wrangler secret` のみ」）。
  - 「管理画面で手動変更しない」（`infra/README.md`）の例外になる。代わりに、設定の内容（モニターの名前・条件・閾値・通知先のチャンネル）を手順書に書き、変えるときは手順書を直す PR を出してから管理画面を変える。
  - 実装PRで、プロバイダ v5 にこれらのリソースがあると確かめられたら、秘密情報を含まない部分（Monitors の条件）を Terraform に移すことを検討する（別タスク）。
- Slack の webhook の URL は、Cloudflare の管理画面と外の監視サービスにだけ登録する。リポジトリ・Terraform・issue・Slack の本文に書かない。漏れたら、Slack 側で作り直す。

### 7. 手順書（`docs/runbooks/monitoring.md`。実装PRで足す）
次の内容を書く。

1. **設定**：Slack のチャンネルと Incoming Webhook の作り方、Cloudflare の通知先の登録、Monitors の一覧（上の表のとおりの名前・条件・閾値）、Issues の自動の通知、外の監視サービスの設定。
2. **アラートごとの最初の対応**：上の表の「意味と、最初にすること」を、ログの引き方（Workers Logs の Query Builder で `event` と時間帯を指定）と一緒に書く。
3. **退避キューの調べ方とやり直し方**（下の「8.」）。
4. **問い合わせの調べ方**（下の「9.」）。
5. **ログを見られる人**（下の「10.」）。

### 8. 退避キューの調べ方とやり直し方
- 気づくきっかけは `job_dead_lettered` の通知。ログの `kind`・`type`・`id`・`error`（例外の名前）と、その前の `job_failed` を Workers Logs で見る。多くはこれで原因が分かる。
- やり直しは、退避キューのメッセージからではなく、outbox の行から行う（処理済みの行は7日残る。T-12）。原因を直してから行う。

| `kind` | やり直し方 |
| --- | --- |
| `outbox` | その `id` の outbox の行の `processed_at` を NULL に戻す。次の毎分の処理が流し直す |
| `notification_deliver` | お知らせの `event_id`（＝ outbox の `id`）を調べ、その outbox の行の `processed_at` を NULL に戻す。届け終えていない分だけが送り直される（T-07） |
| `calendar_sync` | 何もしない。15分以内に、次の割り当てで確かめ直される |

- `processed_at` を戻すのは、人が `wrangler d1 execute --remote` で行う。consumer はどの処理も冪等なので、二重に流れても結果は変わらない（T-06）。
- メッセージの本文を見るのは最後の手段にする。ログと outbox の行で足りることが多い。どうしても要るときだけ、退避キューに HTTP で読む consumer を付けて、API で読む。
  - 読むのは1回だけにし、読んだあと ack しない（見えない時間が過ぎるとキューに戻る）。
  - ack せずに何度も読むと、試行の回数が増え、consumer の再試行の上限に達してメッセージが消えるおそれがある（退避キューには、その先の退避キューがない）。上限の既定値と、達したときの扱いは実装PRで確かめ、手順書に「consumer を付けるときの再試行の上限の設定」を書く。
  - 調べ終えたら、consumer を外す。
  - 本文には outbox の payload（時刻などの行動の情報）や、利用者ID（`calendar_sync`）が入る。Slack・issue・PR に貼らない。
  - 読むための API トークンは、Queues の読み書きだけに絞り、使い終えたら消す。
- 退避キューのメッセージは4日で消える。消える前に調べられなくても、outbox の行（7日）からやり直せる。
- 退避キューを自動で読む処理は作らない（スコープ外）。

### 9. 問い合わせの調べ方
- 最初のリリース（友達だけ）では、画面に問い合わせ番号（`requestId`）を出さない。画面は変えない。
- 友達から「うまく動かなかった」と聞いたら、起きた時刻（おおよそ）と、何をしていたかを聞く。その時間帯の `unhandled_error`・`job_dead_lettered`・`health_degraded` を Workers Logs で引く。
- `unhandled_error` のログには `requestId` がある。ブラウザの開発者ツールで応答が見られる場合は、応答の `requestId` と突き合わせる。
- ログには利用者IDを出していないので、「誰の操作か」はログからは引かない。必要なら時刻から D1 の行を見る。
- 一般公開の前に、画面に問い合わせ番号を出すかを決め直す（スコープ外）。

### 10. ログを見られる人の範囲
- Workers Logs・Issues・Monitors を見られるのは、Cloudflare のアカウントのメンバーだけ。いまは開発者本人だけ。2段階認証を必ず有効にする。
- 人を足すときは、読み取りだけの役割にする。足したら手順書の一覧に書く。
- Slack の2つのチャンネルは非公開にし、メンバーは運営者だけにする。
- ログの保持は Workers Logs の7日。それより長く残す仕組み（Logpush など）は作らない（保存するデータを減らす方針。監査ログは #41）。

## 認可と秘匿
- 閲覧者IDの使い方：追加する API は認証なしで、利用者のデータを読まない。閲覧者IDは使わない。読むのは `cron_runs` と、outbox の未処理の最古の `created_at` だけ。
- 他人のデータに届かないことの保証：応答は `{ "status": "ok" }` か、決まった形の 503 だけ。利用者ID・件数・時刻を返さないことをテストで確かめる。
- 区別させない応答：503 の本文はどの理由でも同じ。outbox の滞留から「誰かが誘いを送った」などは分からない（未処理の行があるかどうかも返さない）。
  - 503 になること自体で「何かが遅れている」ことは外から分かる。これは受け入れる（利用者ごとの情報ではない）。
- ログ：足すログは `reason`・`kind`・`step`・例外の名前だけ。個人情報・トークン・予定の中身を出さない。
- 通知：Slack に流すのはモニターの名前と数。webhook の URL は秘密情報として扱う（「6.」）。
- 回数の上限：`/api/v1/health/ready` は D1 を読むので、IP ごとの上限を付ける。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 記録：毎分の処理の後に `minutely`、15分ごとの割り当ての後に `calendar_sync` の `last_run_at` がいまの時刻になる（時刻は `deps.now`）
- [x] 記録：途中の処理が例外を投げても、記録される
- [x] 記録：記録の書き込みが失敗すると `cron_step_failed`（`step: "heartbeat"`）が出て、`runScheduled` は投げない
- [x] 死活確認：すべて新しければ 200 `{ "status": "ok" }`。認証なしで呼べる
- [x] 死活確認：`minutely` が5分より前なら 503、ちょうど5分なら 200。行がなければ 503
- [x] 死活確認：`calendar_sync` が45分より前なら 503、ちょうど45分なら 200
- [x] 死活確認：流す型の未処理の最古の行が10分より前なら 503、ちょうど10分なら 200。処理済みの行と、流す型でない未処理の行では 503 にならない
- [x] 死活確認：D1 の読み取りが失敗すると 503
- [x] 死活確認：503 の本文はどの理由でも同じで、`code` は `unavailable`。理由・時刻・件数・利用者IDを含まない。`Cache-Control: no-store` が付く
- [x] 死活確認：503 のとき `health_degraded` が `reason` だけで出る。200 のときは出ない
- [x] 死活確認：回数の上限を超えると 429
- [x] ログ：`job_failed`・`job_dead_lettered`・`cron_step_failed` は warn、`unhandled_error` は error で出る。項目は変わらない
- [x] ログ：サービス全体のメール数の上限で送らなかったとき `notification_mail_global_limit` が `kind` だけで出る。利用者ごとの上限では出ない
- [x] 設定：wrangler の設定で、トップレベルと prod の `observability.issues.enabled` が true、`invocation_logs` が false のまま
- [x] 他人のIDでは取得・更新できない：追加する API が利用者のデータを返さない（上の本文のテスト）。既存のテストが通る

### E2Eテスト（対象にする利用者の流れ）
- 対象なし。利用者の画面と流れは変わらない。既存の E2E が通ることで、流れが壊れていないことを確かめる。

### 人が確かめること（本番で設定するとき。手順書に書く）
- わざと条件を満たすログを出し（例：自分のアカウントで更新用トークンを2回使う）、Slack に通知が届くこと。
- 外の監視サービスの確認先を一時的に存在しないパスに変え、メールと Slack に通知が届くこと。
- Workers Issues の問題の詳細と通知に、リクエストの URL（トークンが入りうる）と個人情報が入っていないこと。Slack への自動の通知を作る前に確かめる。

## スコープ外
- 利用料アラート、WAF・ボット対策（#42）。
- 監査ログ（#41）、匿名の集計（NF-08、#46）。
- ログを7日より長く残す仕組み（Logpush、R2 への保存）。
- 退避キューを自動で読む処理、やり直しを行う運営用の API・画面。
- 画面に問い合わせ番号を出すこと。
- Tail Worker で自前の通知を作ること（Monitors が使えない場合の代わりの案。「確認事項」）。
- staging の監視（staging は作っていない。T-12）。

## 確認事項（合意前に解消する）
すべて解消済み（2026-11-21）。

- [x] 通知先：Slack にする。非公開のチャンネル2つ（すぐ見る・気づけばよい）と、死活監視だけメールも足す。
- [x] 外の監視サービス：Better Stack（Uptime）の無料の枠にする。UptimeRobot の無料の枠は Slack への通知が有料になる見込みのため選ばない。Cloudflare の Health Checks はゾーンを Pro にする必要があるので使わない。
- [x] Monitors・Issues の設定を管理画面で人が行うこと（「6.」の例外）：受け入れる。設定の内容は手順書を正とする。
- [x] 閾値（「4.」の表）：この値で始め、運用で見直す。

実装PRで確かめたこと（2026-11-21、公式ドキュメント）：
- Monitors が Workers Logs を読めるか：データセット `logs.workersLogs` はある。ただし「使えるデータセットはプランと権限による」とだけあり、有料の Workers のプランで使えるかは書かれていない（https://developers.cloudflare.com/analytics/sql-api/datasets/、https://developers.cloudflare.com/notifications/monitors/）。**未確認**。設定するときに管理画面で選べなければ、Tail Worker から Slack に送る形に仕様を変える（仕様書を直してから実装する）。
- `event` の値で絞れるか：Workers Logs は JSON の項目を自動で取り出すとあるが、公式の例はオブジェクトをそのまま `console.warn` に渡す形で、文字列にした JSON が項目に分かれるかは書かれていない。**未確認**。そのため、本文（`$metadata.message`）が `"event":"<名前>"` を含むことで絞る（Query Builder で `$metadata.message` を絞り込みに使える。https://developers.cloudflare.com/workers/observability/query-builder/）。ログの書き方は変えない。
- Monitors の実行の間隔：多くのデータセットは1分、Log Explorer のデータセットは10分が下限。作れる数の上限は書かれていない（**未確認**）。
- Workers Issues：捕まえていない例外・失敗した呼び出し・5xx・error のログと、`Error` やスタックを含むログを拾う。queue と scheduled の呼び出しの失敗を拾うかは明記されていない（「呼び出しの失敗」と書かれているので含むと読める。**未確認**）。warn のログは、`Error` やスタックを含まなければ対象にならないと読める（明記はない）。通知の本文には、例外のメッセージ・スタック・要求の情報が入りうる。→ 手順書で、実際の通知の本文を確かめ、個人情報が入りうるなら Issues の Slack への通知をやめて `unhandled_error` のモニターを足す手順にした（https://developers.cloudflare.com/workers/observability/issues/、https://developers.cloudflare.com/workers/observability/issues/automations/）。
- 退避キューに付ける HTTP の consumer：`max_retries` の既定は3。上限に達したメッセージは、その先の退避キューがなければ消える。ack しないと見えない時間（既定30秒）の後に戻り、試行の回数が増える。→ 手順書に「付けるときに `max_retries` を大きめにする」と書いた（https://developers.cloudflare.com/queues/configuration/batching-retries/、https://developers.cloudflare.com/queues/configuration/pull-consumers/）。
- Workers Logs の料金：2026-12-01 から Cloudflare Observability の料金になる。有料プランは請求期間ごとに取り込み50GB・保存10GB-month まで込み（https://developers.cloudflare.com/observability/pricing/）。いまのログの量では込みの範囲に収まる見込み。Monitors 自体に費用がかかるかは書かれていない（**未確認**）。
- Better Stack の無料の枠：確認の間隔は3分から（https://betterstack.com/docs/uptime/check-frequency/）。続けて失敗したときだけ通知する設定は「Confirmation period」（時間で指定）。監視の数・Slack とメールへの通知・利用の制限は、料金のページを直接確かめられなかった（**未確認**）。登録するときに公式で確かめる手順を手順書に書いた。
- wrangler のバージョン：`wrangler deploy --dry-run --env prod`（4.161.0）は `observability.issues` を警告なしで通した。単体テストの実行環境（`@cloudflare/vitest-pool-workers` が持つ wrangler）は「Unexpected fields found in observability field: "issues"」の警告を出すが、テストは通る（実行環境の wrangler が古いため。Workers Issues はテストでは使わない）。

## 実装PRで書き換える仕様書
- docs/requirements.md：「技術の選定」の監視の行（Workers Logs＋Monitors・Issues＋外からの死活監視。利用料アラートは #42）、「残りの論点」の「異常検知のアラートの条件と通知先」にチェックを付ける。
- `api-conventions` スキル：エラーの表に 503 `unavailable` を足す。
- docs/specs/T-06-calendar.md・T-07-notification.md：`job_failed`・`job_dead_lettered` の重さと、`notification_mail_global_limit` のログ。
- docs/specs/T-12-data-growth.md：「#85 のアラートの対象の候補」「退避キューを読む手段はまだない」を、この仕様書への参照に直す。`cron_step_failed` を warn で出すことを足す。
- `infra/README.md`：「管理画面で手動変更しない」に、通知の設定の例外と手順書への参照を足す。`docs/README.md` に `runbooks/` を足す。
- issue #52（本番までに人が行う作業）に、Slack・Cloudflare の通知・外の監視の設定を足す。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-21 | 下書き | 仕様の点検で見つかった「監視とアラートの仕様がない」（#85） |
| 2026-11-21 | Monitors と Workers Issues の受け持ちをログの重さで分ける（二重の通知をなくす）。退避キューを HTTP で読むときの注意と、確かめる項目を足す。本番のドメインの出どころを書く | PR のレビュー |
| 2026-11-21 | 確認事項を解消し、合意済みにする。外の監視サービスを Better Stack に決める | 4つの確認事項を決定（外の監視サービスは利用者と決めた。ほかは案のとおり） |
| 2026-11-21 | 実装した。Monitors は本文の文字列の一致で `event` を絞ることにし、実装PRで確かめたことを書いた。手順書（docs/runbooks/monitoring.md）を足した | 実装PR |
| 2026-11-22 | Workers Issues にリクエストの URL（トークンが入りうる）が載らないかを、Slack への通知を作る前に確かめることを足した。退避キューの本文に利用者ID が入りうることを書いた。T-10 の回数の上限の表に `health_ready` を足した | 実装のあとのレビュー（セキュリティ・仕様） |
