# 手順書：監視とアラート

- 仕様の正：docs/specs/T-13-monitoring.md。この手順書は、その仕様を人が設定・運用するための手順。
- Cloudflare の Monitors・Workers Issues の通知・通知先の webhook は、管理画面で人が設定する（Terraform では管理しない。仕様書「6. 設定の置き場所」の例外）。
  - **この手順書の表が設定の正。** 変えるときは、先にこの手順書を直す PR を出し、マージしてから管理画面を変える。
- 秘密情報（Slack の webhook の URL、API トークン）は、この手順書・リポジトリ・issue・Slack の本文に書かない。

## 1. 設定（本番を公開する前に、人が1回行う）

### 1-1. Slack
1. 非公開のチャンネルを2つ作る。メンバーは運営者だけにする。
   - `#kokohima-alerts`（すぐ見る）：スマホの通知をオン（すべてのメッセージ）にする。
   - `#kokohima-notices`（気づけばよい）：通知はオフでよい。1日1回見る。
2. チャンネルごとに Incoming Webhook を1つ作る。URL は秘密情報として扱う。漏れたら、Slack 側で作り直して登録し直す。

### 1-2. Cloudflare の通知先
1. 管理画面の Notifications の通知先（webhook）に、Slack の Incoming Webhook の URL を2つ登録する。名前は `kokohima-alerts`・`kokohima-notices`。
2. 登録のときのテスト送信が、それぞれのチャンネルに届くことを確かめる。

### 1-3. Monitors（ログの条件）
- 管理画面の Alerts > Monitors で、下の表のとおりに作る。
  - 対象：Workers Logs。Worker は本番（`kokohima-api-prod`）だけに絞る。
  - 数え方：`event` が表の値のログの件数（COUNT）。閾値は「以上」。
  - 実行の間隔：選べるいちばん短いもの。同じ条件が続く間の再通知：1時間（既定）。
  - モニターの名前は表のとおりにし、個人を表す値を入れない（通知にはモニターの名前と数だけが出る）。

| モニターの名前 | `event` | 条件 | 通知先 |
| --- | --- | --- | --- |
| `kokohima refresh_token_reuse` | `refresh_token_reuse` | 15分に1件以上 | `kokohima-alerts` |
| `kokohima job_dead_lettered` | `job_dead_lettered` | 15分に1件以上 | `kokohima-alerts` |
| `kokohima cron_step_failed` | `cron_step_failed` | 15分に3件以上 | `kokohima-alerts` |
| `kokohima calendar_decrypt_failed` | `calendar_decrypt_failed` | 15分に1件以上 | `kokohima-alerts` |
| `kokohima outbox_dispatch_capped` | `outbox_dispatch_capped` | 1時間に1件以上 | `kokohima-notices` |
| `kokohima calendar_sync_assign_full` | `calendar_sync_assign_full` | 1時間に1件以上 | `kokohima-notices` |
| `kokohima rate_limited` | `rate_limited` | 15分に50件以上 | `kokohima-notices` |
| `kokohima login_failed` | `login_failed` | 15分に20件以上 | `kokohima-notices` |
| `kokohima rate_limit_skipped` | `rate_limit_skipped`（`reason` が `no_binding` か `error`） | 1時間に1件以上 | `kokohima-notices` |
| `kokohima notification_push_rejected` | `notification_push_rejected` | 1時間に10件以上 | `kokohima-notices` |
| `kokohima notification_mail_rejected` | `notification_mail_rejected` | 1時間に10件以上 | `kokohima-notices` |
| `kokohima notification_mail_global_limit` | `notification_mail_global_limit` | 1時間に1件以上 | `kokohima-notices` |
| `kokohima calendar_sync_held` | `calendar_sync_held` | 1時間に5件以上 | `kokohima-notices` |

- `unhandled_error` のモニターは作らない。Workers Issues が受け持つ（同じ1件で2通届かないようにするため）。

### 1-4. Workers Issues
1. 本番の Worker で Issues が有効になっていることを確かめる（wrangler の設定 `observability.issues.enabled`。デプロイで有効になる）。
2. 自動の通知を作る前に、「1-6.」の「問題の詳細と通知の本文に、個人情報や URL が入りうるか」を確かめる。入るなら、通知は作らない（「1-6.」の対応に従う）。
3. 自動の通知（Automations）を2つ作る。通知先はどちらも `kokohima-alerts`。
   - 発生した数が1に達したとき（新しい問題）
   - 24時間止まっていた問題が、また起きたとき

### 1-5. 外からの死活監視（Better Stack）
1. Better Stack（Uptime）にアカウントを作る。持つのは開発者本人だけにし、2段階認証を有効にする。
2. 監視を2つ作る。確認の間隔は、無料の枠で選べるいちばん短いもの（3分）。5分より長くしない。
   - `https://kokohima.app/api/v1/health/ready`：ステータスが 200 であること
   - `https://kokohima.app/`：ステータスが 200 であること
3. 2回続けて失敗したら通知し、戻ったときも通知する設定にする。
4. 通知先は、メール（開発者本人）と `#kokohima-alerts`（Better Stack の Slack 連携か、Incoming Webhook）。Slack が止まっていても気づけるよう、メールを必ず入れる。
5. サービスには URL のほかに何も渡さない（認証情報を渡さない）。

### 1-6. 設定するときに確かめること
仕様書を書いた時点で、公式ドキュメントでは確かめきれなかった点。結果をこの表に書く。仕様と合わなければ、仕様書とこの手順書を直す PR を出す。

| 確かめること | 合わなかったとき | 結果 |
| --- | --- | --- |
| Monitors が、いまのプランで Workers Logs を読めるか | Tail Worker から Slack に送る形に仕様を変える | 未確認 |
| Monitors で `event` の値で絞れるか（ログは JSON を文字列にして出している） | 本文の文字列の一致で絞る。それもできなければ、ログをオブジェクトのまま出す形に変える | 未確認 |
| Monitors の実行の間隔の下限と、作れる数の上限 | 数が足りなければ、「気づけばよい」の側からまとめる | 未確認 |
| warn のログが Workers Issues に上がらないか | 二重に届くことをこの手順書に書くか、Issues の通知の条件で絞る | 未確認 |
| Workers Issues が、queue と scheduled の失敗も拾うか | 拾わない分は Monitors（`job_dead_lettered`・`cron_step_failed`）で見ている。追加は要らない | 未確認 |
| Workers Issues の問題の詳細と通知の本文に、個人情報や、リクエストの URL（パス・クエリ）が入りうるか。URL にはトークンが入る経路がある（OAuth のコールバックの `code`、.ics のパス。呼び出しのログを切っている理由） | 通知に入るなら、Issues の Slack への通知をやめて管理画面で見るだけにし、`unhandled_error` のモニター（15分に1件以上、`kokohima-alerts`）を足す。管理画面の詳細にも URL が残るなら、Issues を無効に戻すことを検討する（仕様書を直す） | 未確認 |
| Workers Logs の料金（2026-12-01 から Cloudflare Observability の料金）で、いまのログの量に費用が出ないか | ログの量を減らすか、費用を受け入れるかを決める | 未確認 |
| Better Stack の無料の枠の条件（監視の数・間隔・Slack とメール・続けて失敗したときだけ通知・利用の制限） | 別のサービスにする（仕様書を直す） | 未確認 |
| 退避キューに付ける HTTP の consumer の、再試行の上限の既定値と、上限に達したときの扱い | 「3. 退避キュー」の手順に、consumer を付けるときの設定を書き足す | 未確認 |

### 1-7. 通知が届くことの確認
- 自分のアカウントで、同じ更新用トークンを2回使い（`refresh_token_reuse`）、`#kokohima-alerts` に通知が届くこと。
- Better Stack の確認先を一時的に存在しないパスに変え、メールと `#kokohima-alerts` に通知が届くこと。確かめたら戻す。

## 2. アラートごとの最初の対応

ログは、管理画面の Workers Logs（Query Builder）で、`event` と時間帯を指定して引く。ログに利用者ID・トークン・予定の中身は出ていない。

| 通知 | 意味 | 最初にすること |
| --- | --- | --- |
| `refresh_token_reuse` | 更新用トークンの再利用。盗用の疑い | そのセッションは失効済み。同じ時間帯の `login_failed`・`rate_limited` を見て、続いていないかを確かめる |
| `job_dead_lettered` | 通知・カレンダーの書き込みなどが、再試行を使い切った | 「3. 退避キュー」へ |
| `cron_step_failed` | 定期処理の同じ失敗が続いている | `step`（処理の名前）と `name`（例外の名前）を見る。`dispatch_outbox` なら通知とカレンダーの書き込みが止まっている |
| `calendar_decrypt_failed` | カレンダーの認証情報を復号できない | `CALENDAR_TOKEN_KEYS`・`CALENDAR_TOKEN_CURRENT_KID` の設定を確かめる |
| Workers Issues | API の想定外の例外（`unhandled_error`）か、アプリのログを通らない失敗 | Issues の画面で例外を見る。`unhandled_error` なら `requestId` と例外の名前でログを引く |
| 死活確認の失敗 | Worker・D1 の障害、定期処理の停止、outbox の滞留 | `health_degraded` の `reason` を見る（下の表） |
| 「気づけばよい」の通知 | 上限に達した・拒否が多い | 仕様書「4. アラートの一覧」の意味を見て、上限や設定の見直しを検討する |

`health_degraded` の `reason`：

| `reason` | 意味 | 見るもの |
| --- | --- | --- |
| `db` | D1 を読めない | Cloudflare の障害情報、D1 の状態 |
| `cron_minutely` | 毎分の処理が5分より前から動いていない | Worker の Cron の設定と実行の履歴、直近のデプロイ |
| `cron_calendar_sync` | 15分ごとの割り当てが45分より前から動いていない | 同上 |
| `outbox_backlog` | 流す型の未処理の outbox の行が、10分より前から残っている | `cron_step_failed`（`step: "dispatch_outbox"`）と `outbox_dispatch_capped` |

- 503 の応答には理由を入れていない。理由はログにだけ出る。
- `health_degraded` は、死活確認の API が呼ばれたときにだけ出る。

## 3. 退避キューの調べ方とやり直し方

1. `job_dead_lettered` のログの `kind`・`type`・`id`・`error`（例外の名前）と、その前の `job_failed` を Workers Logs で見る。多くはこれで原因が分かる。
2. 原因を直す（設定の誤り、外のサービスの障害など）。
3. やり直す。退避キューのメッセージからではなく、outbox の行から行う（処理済みの行は7日残る）。

| `kind` | やり直し方 |
| --- | --- |
| `outbox` | その `id` の outbox の行の `processed_at` を NULL に戻す。次の毎分の処理が流し直す |
| `notification_deliver` | お知らせ（`notifications`）の `event_id`（＝ outbox の `id`）を調べ、その outbox の行の `processed_at` を NULL に戻す。届け終えていない分だけが送り直される |
| `calendar_sync` | 何もしない。15分以内に、次の割り当てで確かめ直される |

- `processed_at` を戻すのは、人が行う。consumer はどの処理も冪等なので、二重に流れても結果は変わらない。

```bash
wrangler d1 execute kokohima-prod --remote --env prod --command "UPDATE outbox SET processed_at = NULL WHERE id = '<outbox の id>'"
```

- メッセージの本文を見るのは最後の手段にする。どうしても要るときだけ、次のようにする。
  1. 退避キュー（`kokohima-prod-outbox-dlq`）に、HTTP で読む consumer を付ける（`wrangler queues consumer http add kokohima-prod-outbox-dlq`）。
  2. Queues の読み書きだけに絞った API トークンで、1回だけ読む。読んだあと ack しない（見えない時間が過ぎるとキューに戻る）。
     - ack せずに何度も読むと、試行の回数が増え、メッセージが消えるおそれがある。読むのは1回だけにする。
  3. 調べ終えたら、consumer を外し、API トークンを消す。
  - 本文には outbox の payload（時刻などの行動の情報）や利用者ID（`calendar_sync`）が入る。Slack・issue・PR に貼らない。
- 退避キューのメッセージは4日で消える。消える前に調べられなくても、outbox の行（7日）からやり直せる。

## 4. 問い合わせの調べ方
- 最初のリリース（友達だけ）では、画面に問い合わせ番号（`requestId`）を出していない。
- 友達から「うまく動かなかった」と聞いたら、起きた時刻（おおよそ）と、何をしていたかを聞く。その時間帯の `unhandled_error`・`job_dead_lettered`・`health_degraded` を Workers Logs で引く。
- `unhandled_error` のログには `requestId` がある。ブラウザの開発者ツールで応答が見られる場合は、応答の `requestId` と突き合わせる。
- ログには利用者IDを出していないので、「誰の操作か」はログからは引かない。必要なら時刻から D1 の行を見る。

## 5. ログを見られる人
- Workers Logs・Issues・Monitors を見られるのは、Cloudflare のアカウントのメンバーだけ。2段階認証を必ず有効にする。
- 人を足すときは、読み取りだけの役割にし、下の表に書く。
- Slack の2つのチャンネルと Better Stack のアカウントも、運営者だけにする。
- ログの保持は Workers Logs の7日。それより長く残す仕組みは作っていない。

| 人 | Cloudflare | Slack のチャンネル | Better Stack |
| --- | --- | --- | --- |
| 開発者本人 | 管理者 | 2つとも | 持つ |
