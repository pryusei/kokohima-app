# 手順書：監視とアラート

仕様の正は docs/specs/T-13-monitoring.md。この手順書は、その仕様を運用するための手順をまとめたもの。設定の内容（モニターの名前・条件・閾値・通知先）はこの手順書を正とし、変えるときは先にこの手順書を直す PR を出してから、管理画面を変える（`infra/README.md` の「管理画面で手動変更しない」の例外）。

- 秘密情報（Slack の webhook の URL、API トークン）は、この手順書・リポジトリ・issue・PR・Slack の本文に書かない。
- ログの本文（`sessionId`・`id` など）は Slack に流さない。Cloudflare の管理画面で見る。例外は問い合わせの `#kokohima-contact` だけ（問い合わせの内容とメールアドレスが入る。docs/specs/T-24-contact.md。「7. 問い合わせの受け方」）。

## 1. 設定

### 1-1. Slack
1. 非公開のチャンネルを3つ作る。メンバーは運営者だけにする。ワークスペースは2段階認証を必須にする。
   - `#kokohima-alerts`（すぐ見る）：スマホの通知をオンにする。
   - `#kokohima-notices`（気づけばよい）：通知はオフでよい。1日1回見る。
   - `#kokohima-contact`（問い合わせ。T-24）：通知はオン。メンバーは、アプリ（Incoming Webhook）の投稿を消せる役割（ワークスペースのオーナーか管理者）の運営者だけ。ゲスト・Slack コネクト（外のワークスペースとの共有）・ほかのアプリの連携を入れない。保持の設定を「90日を過ぎたら消す」にする（チャンネルの単位でできなければワークスペース。ワークスペースにすると、監視の2つのチャンネルも90日で消えるが、受け入れる）。
2. 監視の2つのチャンネル（`#kokohima-alerts`・`#kokohima-notices`）に Incoming Webhook を作る（Slack のアプリの設定 → Incoming Webhooks）。URL はパスワードと同じに扱い、次の2か所にだけ登録する（docs/specs/T-13-monitoring.md「6.」）。
   - Cloudflare の管理画面の通知先（「1-2.」）
   - 外の監視サービス（Better Stack。「1-5.」。`#kokohima-alerts` の分だけ）
3. 監視の webhook の URL が漏れたら、Slack 側で webhook を作り直し、上の2か所に登録し直す。
4. 問い合わせの `#kokohima-contact` の webhook（T-24）は、監視の webhook とは別に作り、上の2か所には登録しない。登録するのは `wrangler secret put CONTACT_SLACK_WEBHOOK_URL --env prod` だけ（staging に入れるかは T-24 の確認事項。入れないと、staging の問い合わせは退避キューに入るだけ）。漏れたら Slack 側で作り直し、`wrangler secret put` し直す。

### 1-2. Cloudflare の通知先（webhook）
1. 管理画面の Notifications → Destinations → Webhooks で、2つの webhook を登録する。
   - 名前：`kokohima-alerts`・`kokohima-notices`（チャンネル名と同じ）。
   - URL：1-1 の Incoming Webhook の URL（Slack の URL は、そのまま登録できる）。
2. 登録したら「テスト」で、それぞれのチャンネルに届くことを確かめる。

### 1-3. Monitors（Workers Logs を数える）
- 管理画面の Notifications → Monitors で作る。対象のデータセットは本番の Worker の Workers Logs（`logs.workersLogs`）。
- ログは1行の JSON を文字列にして出している（例：`{"event":"job_dead_lettered","kind":"outbox",...}`）。`event` で絞るときは、本文（`$metadata.message`）が `"event":"<名前>"` を含むことで絞る（JSON を項目に分けて読めるかは公式で確かめられていない。読めることが分かったら、項目で絞る形に直してよい）。
  - `rate_limit_skipped` の行は、さらに本文が `"reason":"no_binding"` か `"reason":"error"` を含むことで絞る（`no_client_ip` は数えない）。
  - `cleanup_capped` は、実行の間隔が違う step を1つのモニターで合計すると閾値が合わないので、`"step":"<名前>"` のどれかを含むことで2つに分ける（毎分の step と15分ごとの step）。「含まない」で除く書き方は確かめていないので、毎分のほうも step の名前を並べる。step を足したら、どちらかの並びに足す（docs/specs/T-17-retention.md「9.」）。
- 評価の期間は下の表の「条件」の期間。実行の間隔は1分（データセットによっては10分が下限）。同じ条件が続く間の再通知は既定（1時間ごと）のまま。
- モニターの名前に、個人を表す値を入れない。名前は下の表の「モニターの名前」をそのまま使う。

**すぐ見る（通知先：`kokohima-alerts`）**

| モニターの名前 | 絞る本文 | 条件 |
| --- | --- | --- |
| `refresh_token_reuse` | `"event":"refresh_token_reuse"` | 15分に1件以上 |
| `job_dead_lettered` | `"event":"job_dead_lettered"` | 15分に1件以上 |
| `cron_step_failed` | `"event":"cron_step_failed"` | 15分に3件以上 |
| `calendar_decrypt_failed` | `"event":"calendar_decrypt_failed"` | 15分に1件以上 |

**気づけばよい（通知先：`kokohima-notices`）**

| モニターの名前 | 絞る本文 | 条件 |
| --- | --- | --- |
| `outbox_dispatch_capped` | `"event":"outbox_dispatch_capped"` | 1時間に1件以上 |
| `calendar_sync_assign_full` | `"event":"calendar_sync_assign_full"` | 1時間に1件以上 |
| `rate_limited` | `"event":"rate_limited"` | 15分に50件以上 |
| `login_failed` | `"event":"login_failed"` | 15分に20件以上 |
| `rate_limit_skipped` | `"event":"rate_limit_skipped"` かつ `"reason":"no_binding"`／`"reason":"error"` | 1時間に1件以上 |
| `notification_push_rejected` | `"event":"notification_push_rejected"` | 1時間に10件以上 |
| `notification_mail_rejected` | `"event":"notification_mail_rejected"` | 1時間に10件以上 |
| `notification_mail_global_limit` | `"event":"notification_mail_global_limit"` | 1時間に1件以上 |
| `wish_suggest_global_limit` | `"event":"wish_suggest_global_limit"` | 1時間に1件以上 |
| `wish_suggest_config_invalid` | `"event":"wish_suggest_config_invalid"` | 1時間に1件以上 |
| `calendar_sync_held` | `"event":"calendar_sync_held"` | 1時間に5件以上 |
| `contact_delivered_after_withdrawal` | `"event":"contact_delivered_after_withdrawal"` | 1時間に1件以上 |
| `cleanup_capped_minutely` | `"event":"cleanup_capped"` かつ `"step":"cleanup_notifications"`／`"step":"cleanup_invitations"`／`"step":"cleanup_broadcasts"`／`"step":"cleanup_invite_links"`／`"step":"cleanup_recurrence_exceptions"`／`"step":"cleanup_stale_notification_outbox"` | 1時間に30件以上 |
| `cleanup_capped_15min` | `"event":"cleanup_capped"` かつ `"step":"mark_dormant_connections"`／`"step":"wake_dormant_connections"`／`"step":"cleanup_push_subscriptions"` | 1時間に3件以上 |

- 閾値は、友達だけ（100人程度）の運用を前提にした最初の値。変えたら、この表と仕様書の「アラートの一覧」を一緒に直す。
- Monitors が数えるログは warn 以下で出している。error で出すと Workers Issues からも届き、二重になる（仕様書「3.」）。

### 1-4. Workers Issues と自動の通知
1. wrangler の設定で `observability.issues.enabled: true` にしてある（トップレベルと prod）。設定に書かないと次のデプロイで無効に戻るので、消さない。
2. 自動の通知を作る前に、管理画面の Workers → 本番の Worker → Issues で、問題の詳細を1つ開く。**リクエストの URL（パス・クエリ）が表示されるか**を確かめる。
   - このアプリには、URL にトークンが入る経路がある（OAuth のコールバックの `code`、`.ics` のパス）。そのために、呼び出しのログ（`invocation_logs`）を切っている（docs/specs/T-06-calendar.md 決定事項14）。Issues が URL を残すと、同じものが別の場所に残る。
   - 問題がまだ1つもなければ（最初のデプロイの直後など）、3 には進まない。Slack への自動の通知は作らずに、最初の問題が出るのを待つ。
     - 待つあいだ、想定外の例外に気づけるよう、`unhandled_error` のモニター（本文が `"event":"unhandled_error"` を含む、15分に1件以上、`kokohima-alerts`）を 1-3 に足しておく。
     - 最初の問題が出たら、その詳細で URL が表示されるかを確かめる。表示されなければ 3 に進み、足しておいた `unhandled_error` のモニターを消す（同じ1件で2通届かないようにするため）。
   - URL が表示されるなら、Slack への自動の通知は作らない（作っていたら消す）。Issues は管理画面で見るだけにし、`unhandled_error` のモニター（本文が `"event":"unhandled_error"` を含む、15分に1件以上、`kokohima-alerts`）を 1-3 に足す。管理画面の詳細に URL が残ること自体を受け入れるか、Issues を無効に戻すかは、仕様書を直す PR で決める。
3. 管理画面の Workers → 本番の Worker → Issues → Automations で、自動の通知を2つ作る。通知先は `kokohima-alerts`。
   - 新しい問題が1回起きたとき。
   - 24時間止まっていた問題がまた起きたとき。
4. 作ったら、実際に届いた通知の本文に、個人情報とリクエストの URL が入っていないかを確かめる（例外の要約・スタックが入る）。入りうるなら、Issues の Slack への通知をやめて管理画面で見るだけにし、`unhandled_error` のモニター（本文が `"event":"unhandled_error"` を含む、15分に1件以上、`kokohima-alerts`）を 1-3 に足す。

### 1-5. 外からの死活監視（Better Stack Uptime）
1. Better Stack のアカウントを開発者本人だけで作り、2段階認証を有効にする。登録するとき、無料の枠の条件（監視の数・確認の間隔・Slack とメールへの通知・利用の制限）を料金のページで確かめる。合わなければ仕様書を直す。
2. 監視を2つ作る。サービスには URL のほかに何も渡さない。
   - `https://kokohima.app/api/v1/health/ready`：200 であること。
   - `https://kokohima.app/`：200 であること。
3. 確認の間隔は、無料の枠で選べるいちばん短いもの（3分）。5分より長くしない。
4. 「Confirmation period」（失敗が続いたら通知するまでの時間）を、2回分（6分）にする。戻ったときも通知する。
5. 通知先は、メール（開発者本人）と `#kokohima-alerts`（Better Stack の Slack 連携か、1-1 の Incoming Webhook）。Slack が止まっていても気づけるよう、メールを必ず入れる。

### 1-6. 設定できたことを確かめる（人が行う）
- わざと条件を満たすログを出し、Slack に届くこと（例：自分のアカウントで、使った更新用トークンをもう一度使う → `refresh_token_reuse`）。
- Better Stack の確認先を一時的に存在しないパスに変え、メールと Slack に届くこと。確かめたら元に戻す。

## 2. アラートごとの最初の対応

ログの引き方：管理画面の Workers → 本番の Worker → Observability → Query Builder（Workers Logs）で、時間帯を指定し、本文（`$metadata.message`）に `"event":"<名前>"` を含むもので絞る。ログの保持は7日。

| アラート | 意味 | 最初にすること |
| --- | --- | --- |
| `refresh_token_reuse` | 更新用トークンの再利用。盗用の疑い。そのセッションは失効済み | 同じ時間帯の `login_failed`・`rate_limited` を見る |
| `job_dead_lettered` | 通知・カレンダーの書き込み・OGP の取得などが再試行を使い切った | 「3. 退避キューの調べ方とやり直し方」へ |
| `cron_step_failed` | 定期処理の同じ失敗が続いている | ログの `step` と `name`（例外の名前）を見る。D1 か Queue の障害なら、`health_degraded` も出ているはず |
| `calendar_decrypt_failed` | カレンダーの認証情報を復号できない | `CALENDAR_TOKEN_KEYS`・`CALENDAR_TOKEN_CURRENT_KID` の設定（`wrangler secret`・vars）を確かめる |
| Workers Issues | 想定外の例外、アプリのログを通らない失敗（捕まえていない例外、CPU 時間の超過など） | Issues の画面で例外の名前と発生の数を見る。`unhandled_error` のログの `requestId` で、その要求のログを引く |
| 外からの死活確認 | `/api/v1/health/ready` か `/` が続けて失敗した | Workers Logs で `health_degraded` の `reason` を見る（`db`：D1 の障害、`cron_minutely`・`cron_calendar_sync`：定期処理の停止、`outbox_backlog`：outbox の滞留）。`/` だけなら Web の配信を見る |
| `outbox_dispatch_capped` | outbox を流す量が1回の実行の上限（10回＝1000件か、20秒）に達した | 続くなら上限の見直し（docs/specs/T-12-data-growth.md） |
| `calendar_sync_assign_full` | カレンダーの確認の割り当てが上限（1000人）で埋まった | 続くなら上限の見直し（T-12） |
| `rate_limited` | 回数の上限の超過が多い | `group` を見る。悪用か、上限が低すぎるか |
| `login_failed` | ログインの失敗が多い | 同じ時間帯の `rate_limited`（`auth_start`）を見る |
| `rate_limit_skipped` | 回数の上限が効いていない | wrangler の `ratelimits` の設定を確かめる |
| `notification_push_rejected`・`notification_mail_rejected` | 送り先・配信サービスに拒否されている | `status` を見る。Resend の管理画面・プッシュの鍵（VAPID）を確かめる |
| `notification_mail_global_limit` | サービス全体の1日のメール数の上限（`MAIL_DAILY_LIMIT`）に達した | 1日の量を見て、上限か Resend の枠の見直し |
| `calendar_sync_held` | カレンダーの大きな変化での保留が多い（T-06） | 一時的なものか、同じ人で続いていないかを見る |
| `job_dead_lettered`（`type` が `ContactMessageSubmitted`） | 問い合わせを Slack に届けられなかった（T-24） | webhook の作り直し・チャンネルの削除・`CONTACT_SLACK_WEBHOOK_URL` の設定を疑う（`error` が `ContactWebhookNotConfigured` なら URL の形、`ContactWebhookRejected` なら Slack の応答）。直したら、その `id` の outbox の行の `processed_at` を NULL に戻す（「3.」）。退避キューのメッセージには受付番号しかないので、本文を見る必要はない |
| `contact_delivered_after_withdrawal` | 問い合わせを届けている間に、送り主が退会した（T-24） | ログの `id`（受付番号）のメッセージを `#kokohima-contact` で探して消す。返事はしない |
| `cleanup_capped_minutely`・`cleanup_capped_15min` | 保持期間の掃除（毎分）・休眠の処理と購読の掃除（15分ごと）が、上限いっぱいまで処理する実行が続いている（T-17） | `step` と `count` を見る。お知らせの期間を変えた直後などの一時的なものか、続くなら上限の見直し（docs/specs/T-17-retention.md「9.」） |

## 3. 退避キューの調べ方とやり直し方

1. `job_dead_lettered` の通知が来たら、Workers Logs で、そのログの `kind`・`type`・`id`・`error`（例外の名前）と、その前の `job_failed` を見る。多くはこれで原因が分かる。
2. 原因を直す（設定の誤り、外のサービスの障害が終わるのを待つ、コードの修正のデプロイ）。
3. やり直しは、退避キューのメッセージからではなく、outbox の行から行う（処理済みの行は7日残る。T-12）。

| `kind` | やり直し方 |
| --- | --- |
| `outbox` | その `id` の outbox の行の `processed_at` を NULL に戻す。次の毎分の処理が流し直す |
| `notification_deliver` | お知らせの `event_id`（＝ outbox の `id`）を調べ、その outbox の行の `processed_at` を NULL に戻す。届け終えていない分だけが送り直される（T-07） |
| `calendar_sync` | 何もしない。15分以内に、次の割り当てで確かめ直される |

- `processed_at` を戻すのは、人が次のように行う（`<id>` は outbox の行の ID。ログの `id` の値を、引用符などを足さずにそのまま貼る）。consumer はどの処理も冪等なので、二重に流れても結果は変わらない（T-06）。

```bash
pnpm --filter api exec wrangler d1 execute kokohima-prod --remote --env prod --command "UPDATE outbox SET processed_at = NULL WHERE id = '<id>'"
```

- お知らせの `event_id` を調べるときは、`notifications` の `id`（`notification_deliver` のログの `id`）で引く。

### 3-1. メッセージの本文を見る（最後の手段）
ログと outbox の行で足りることが多い。どうしても要るときだけ行う。

1. Queues の読み書きだけに絞った API トークンを作る（使い終えたら消す）。
2. 退避キュー（`kokohima-prod-outbox-dlq`）に、HTTP で読む consumer を付ける（`wrangler queues consumer http add kokohima-prod-outbox-dlq`）。
   - 付けるとき、再試行の上限（`max_retries`）を大きめにする。既定は3で、ack せずに読むたびに試行の回数が増え、上限に達するとメッセージが消える（退避キューには、その先の退避キューがない）。
3. API で1回だけ読み、ack しない（見えない時間（既定30秒）が過ぎるとキューに戻る）。
4. 調べ終えたら、consumer を外し（`wrangler queues consumer http remove kokohima-prod-outbox-dlq`）、API トークンを消す。

- 本文には outbox の payload（時刻などの行動の情報）や、利用者ID（`calendar_sync`）が入る。Slack・issue・PR に貼らない。
- 退避キューのメッセージは4日で消える。消える前に調べられなくても、outbox の行（7日）からやり直せる。

## 4. 不具合の知らせの調べ方

1. 友達から「うまく動かなかった」と聞いたら、起きた時刻（おおよそ）と、何をしていたかを聞く。
2. その時間帯の `unhandled_error`・`job_dead_lettered`・`health_degraded` を Workers Logs で引く。
3. `unhandled_error` のログには `requestId` がある。ブラウザの開発者ツールで応答が見られる場合は、応答の `requestId` と突き合わせる。
4. ログには利用者IDを出していないので、「誰の操作か」はログからは引かない。必要なら時刻から D1 の行を見る。
5. フォーム（設定 → 問い合わせ。T-24）で届いた不具合も、Slack の「受付」の時刻から、その時間帯のログを引く。API の要求のログには受付番号も利用者 ID も出ないので、受付番号では引けない（届けるのに失敗したときの `job_failed` には、受付番号が `id` として出る）。

- 最初のリリース（友達だけ）では、画面に問い合わせ番号を出さない。一般公開の前に決め直す。

## 5. ログを見られる人

| 対象 | 見られる人 | 条件 |
| --- | --- | --- |
| Cloudflare のアカウント（Workers Logs・Issues・Monitors・D1） | 開発者本人 | 2段階認証を必ず有効にする |
| Slack の `#kokohima-alerts`・`#kokohima-notices` | 開発者本人 | 非公開のチャンネル |
| Slack の `#kokohima-contact`（問い合わせ。内容とメールアドレスが入る） | 開発者本人 | 非公開のチャンネル。アプリの投稿を消せる役割 |
| Better Stack | 開発者本人 | 2段階認証を必ず有効にする |

- 人を足すときは、Cloudflare では読み取りだけの役割にし、この表に足す。
- ログの保持は Workers Logs の7日。それより長く残す仕組み（Logpush など）は作らない。

## 6. 費用

- 2026-12-01 から、Workers Logs は Cloudflare Observability の料金になる（有料プランは請求期間ごとに取り込み50GB・保存10GB-month まで込み、超えた分は従量。https://developers.cloudflare.com/observability/pricing/ ）。いまのログの量（1行の短い JSON）では込みの範囲に収まる見込み。月に1回、管理画面で量を見る。
- Workers Issues はオープンベータの間は無料。

## 7. 問い合わせの受け方（docs/specs/T-24-contact.md「振る舞い 7.」）

- 届くのは `#kokohima-contact` だけ。内容を、監視のチャンネル・issue・PR・ほかのチャンネルに貼らない。
- 返信は `ops@kokohima.app` から、Slack に出た「返信先」に送る。「返信先：登録なし」なら返事はできない。
- 「個人情報の開示・削除の請求」は、ログインして送ったこと（利用者 ID）で本人と確かめ、登録のメールアドレスにだけ答える（T-19「12.」）。
- 届いた文には受付番号が入る。同じ受付番号が2通届いたら（Slack が受け取ったあと、書き換えの前に止まった）、1通として扱う。
- 対応を終えたら、Slack のメッセージを消す。
- 月に1回、`#kokohima-contact` に90日より古いメッセージが残っていないかを見て、保持の設定（「1-1.」）が効いているかを確かめる。

### 7-1. 人が確かめること（本番で設定するとき）
- 保持の設定：無料のプランで「90日を過ぎたら消す」にできること・設定したこと。できなければ、有料のプランにするか、仕様書とポリシーの日数を直す。
- 誰がアプリ（Incoming Webhook）の投稿を消せるか。運営者がその役割にあること。
- staging か本番で自分のアカウントから1通送り、届いた文を見る：
  - `&`・`<`・`>` が文字どおりに出る（`&amp;` などのまま出たら、T-24「4.」のとおり仕様を直す）。
  - `<!channel>`・`@channel`・`@here`・`<@自分のID>`・`<https://example.com|押して>`・`*太字*`・`:smile:` が、メンション・リンク・書式・絵文字にならない。
  - URL を書いても、リンクの展開（プレビュー）が出ない。
  - Slack のスマホの通知に、内容とメールアドレスが出ない。
  - 運営者の役割で、そのメッセージを消せる。
- チャンネルが非公開で、メンバーが運営者だけであること。
