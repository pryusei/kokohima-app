# T-17 仕様書：古いデータの掃除と保持期間

- 状態：下書き
- タスク票：docs/tasks/T-17-retention.md
- 関係する要件：要求定義書「AI時代の攻撃を前提にした運用」（保存するデータを減らす）、NF-08。issue pryusei/kokohima-app#38 の残り

## 概要
終わった誘い・募集・成立した予定は、今は無期限に残っている（相手・時刻・エリア・ひとこと・リンク）。これを、予定の時間の終わりから30日で、毎分の掃除で消す。お知らせも30日にそろえる。期限の過ぎた招待リンク、過去のくり返しの例外、友達でなくなった相手との「見せる」の公開設定、流れないまま残る通知の記録、使えないセッションのプッシュの購読も消す。また、30日アプリを開いていない人（休眠中の人）の連携では、カレンダーの定期の確認を止め、埋まりの記録を消す。表ごとの保持期間は1つの表にまとめる。

## 決めたこと（利用者の回答）
1. 終わった誘い・募集・成立した予定は、終わってから30日で消す。数え方は予定の時間の終わり（作った日や、返事の日ではない）。
2. お知らせも、すべて30日で消す（今は90日。T-07 を直す）。
3. 休眠中の人＝30日アプリを開いていない人。判定は、使える更新用トークンがなく、かつ、その人のセッションの最後に使った時刻（`last_used_at` の一番新しいもの）が30日より前（「8.」）。ログアウトしただけ・失効させただけでは、すぐには休眠にならない。休眠中の人の、カレンダーの定期の確認は止める。
4. 休眠になったら、埋まりの記録を消す。Google の許可（更新用トークン）は残し、連携は続く。ログインし直したら、新しく連携したときと同じく「記録だけ」から始める（まとめての取り消しは起きない）。
5. 友達を解除したら、両方向の公開設定のうち「見せる」（`visible = 1`）の行だけを消す。「見せない」（`visible = 0`）の行は退会まで残す（退会で消える。T-16）。同じ招待リンクなどで友達に戻っても、以前の「見せない」は残る（T-02 決定事項5 のとおり）。「見せる」の行は初期値と同じなので、消しても見え方は変わらない。
6. 成立数の集計（NF-08）のための記録は、今は残さない。過去の成立を後から数えられなくなることを受け入れる（#46 で集計を作るときに決める）。

## API
変更なし。ただし、次の応答が変わる。
- 期限から30日を過ぎた自分の招待リンクの無効化（`POST /invite-links/{id}/revoke`）は、行が消えるので204でなく404になる（T-02 の「期限切れでも204」を直す）。
- 消えた誘い・募集・予定は、ほかの見つからないものと同じ404。

## データ
マイグレーション（その時点の次の空いている番号）：
- 列：`calendar_connections.dormant_since INTEGER`（NULL なら休眠でない）。
- インデックス：
  - `direct_invites (ends_at)`、`broadcasts (ends_at)`、`invite_links (expires_at)`、`recurrence_exceptions (local_date)`（掃除で表全体を読まない）
  - `ics_tokens (meetup_id)`（予定を消すときの CASCADE の子の検索。ほかの子の列は UNIQUE か主キーで、すでにインデックスがある）
  - 定期の確認の割り当て：今の `calendar_connections_sync (status, last_synced_at)` を消し、`calendar_connections_sync (status, dormant_since, last_synced_at)` を作る。今の `connectionsDueForSync`（T-16 で、退会した人を外す `EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)` が入っている）に `AND dormant_since IS NULL` を足した次の SQL が、`status = 'active'` と `dormant_since IS NULL` の等しい条件で範囲を絞り、`last_synced_at` の順に読んで `LIMIT` で止まる（休眠中の行は範囲の外。退会した人の条件は、読んだ行ごとに `users` の主キーで確かめる。退会した人の連携は T-16 の後始末で消えるので、外れる行は少ない）。
    ```sql
    SELECT user_id, provider FROM calendar_connections
    WHERE status = 'active' AND dormant_since IS NULL
      AND (last_synced_at IS NULL OR last_synced_at <= ?1)
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = calendar_connections.user_id AND u.withdrawn_at IS NULL)
    ORDER BY last_synced_at LIMIT ?2
    ```
- 今ある、友達でない相手との「見せる」の公開設定の行を消す（1回だけ）。「見せない」の行は消さない。
  ```sql
  DELETE FROM sharing_policies
  WHERE visible = 1
    AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = sharing_policies.owner_id AND f.friend_id = sharing_policies.target_id)
    AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = sharing_policies.target_id AND f.friend_id = sharing_policies.owner_id)
  ```

## 振る舞い

### 1. 保持期間の一覧
この表を、保持期間の正とする。期間を変えるときは、この表と、該当の仕様書を同じPRで直す。

| データ | 消す時点 | 決めた仕様書 |
| --- | --- | --- |
| 誘い（`direct_invites`）と、そこから成立した予定・参加者・.ics の鍵・リンクの参照 | 時間の終わり（代わりの時間があれば遅い方）から30日 | この仕様書 |
| 募集（`broadcasts`）と、宛先・成立した予定・参加者・.ics の鍵・リンクの参照 | 時間の終わりから30日 | この仕様書 |
| お知らせ（`notifications`） | 作ってから30日 | この仕様書（T-07 の90日を直す） |
| お知らせの日ごとの数 | UTC で3日前の日付より前 | T-07 |
| 招待リンク（`invite_links`） | 期限から30日 | この仕様書 |
| くり返しの例外（`recurrence_exceptions`） | 日付が UTC の今日の2日前より前（日付から3日目に消える） | この仕様書 |
| 公開設定の「見せる」の行（`sharing_policies`、`visible = 1`） | 友達でなくなったとき・退会のとき | この仕様書、T-16 |
| 公開設定の「見せない」の行（`sharing_policies`、`visible = 0`） | 退会のとき（友達を解除しても残す） | T-02 決定事項5、T-16 |
| ここ暇の手動の枠（`availabilities`） | 始まりから1日＋24時間 | T-12 データの増加 |
| 処理済みの outbox | 処理から7日 | T-12 データの増加 |
| 流れないままの通知だけの型の outbox（`NOTIFICATION_START_AT` が未設定の間） | 作ってから30日 | この仕様書 |
| 退避キュー（Queue `kokohima-*-outbox-dlq`） | Queues の保持期間（既定4日） | T-13 の手順書 |
| セッション・更新用トークン | 失効・期限切れから30日（利用者ごとに最初の1行を残す） | T-01、pryusei/kokohima-app#82 |
| プッシュの購読 | ログアウト・失効のとき、送れなかったとき、セッションが失効・期限切れになったら15分ごとの掃除で（残す最初のセッションの分も）、退会のとき | T-07、この仕様書、T-16 |
| ログインの記録（`oauth_transactions`・`login_codes`） | 期限切れ | T-01 |
| 冪等キー | 24時間 | T-10 |
| 埋まりのキャッシュ（KV） | 5分 | T-10 |
| リンクのプレビューの結果 | 参照がなく、取得から30日（取得中のまま1時間） | T-08 |
| リンクのプレビューの画像（R2・台帳） | 参照する結果がなくなってから1時間 | T-08 |
| カレンダーの連携の state・.ics の鍵 | 期限切れ | T-06 |
| カレンダーの連携の更新用トークン・埋まりの記録 | 解除のとき・Google 側で失効したとき（埋まりの記録は休眠になったときも。更新用トークンは休眠中も残す） | T-06、この仕様書 |
| カレンダーの連携の行 | 退会のとき（解除しても `disconnected` の行が残る） | T-06、T-16 |
| 利用者・ログインの方法・友達・時間帯・くり返しのルール・通知の設定 | 退会のとき（利用者の行は ID だけ残す） | T-16 |
| 定期処理の記録（`cron_runs`） | 処理ごとに1行を上書き | T-13 |
| Workers Logs | 7日 | T-13 |

### 2. 終わった誘い・募集・予定
- 毎分の掃除で、次の行を消す。状態では絞らない（誘いの期限は開始まで。T-04。時間の終わりを過ぎていれば、どの状態でも終わっている）。
  - 誘い：`ends_at < ?cutoff AND (counter_ends_at IS NULL OR counter_ends_at < ?cutoff)`。`?cutoff` は今から30日前（ちょうど30日の行は残る）。代わりの時間で成立した予定は代わりの時間で作られるので、その終わりまで待つ。代わりの時間が元の時間よりずっと後の行は、毎回読んで外すことになるが、数は少ない。
  - 募集：`ends_at < ?cutoff`。
- 予定（`meetups`）・参加者（`meetup_participants`）・宛先（`broadcast_recipients`）・.ics の鍵（`ics_tokens`）・リンクの参照（`link_preview_refs`）は、外部キーの CASCADE で一緒に消える。予定は誘い・募集と同じ時間なので、予定だけ先に消えることも、予定だけ残ることもない。参照がなくなったリンクのプレビューは、T-08 の掃除で消える。
- 両方の参加者の履歴から同時に消える。お知らせも30日で消えるので（「3.」）、片方の人にだけ相手の記録が長く残ることはない。
- 1回に消す数：誘いは1000行（`CLEANUP_BATCH`）、募集は100行（宛先が最大100人いて、CASCADE で消える行が多いため）。`DELETE ... WHERE id IN (SELECT id ... ORDER BY ends_at LIMIT ?)`。
- 自分の Google の「ここ暇」カレンダーに書いた、過去の予定は消さない（予定の書き込みは、終わった予定を消さない。T-06）。

### 3. お知らせ
- 作ってから30日（`inserted_at`）を過ぎたお知らせを消す（今の90日の掃除の期間を変える）。ちょうど30日の行は残る。
- 今の `deleteOldNotifications` には上限がないので、上限を付ける：`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE inserted_at < ?1 LIMIT 1000)`（インデックス `notifications_inserted` を使う）。上限いっぱいまで消したら `cleanup_capped`（「9.」）。
- 90日から30日に変えた直後は、30〜90日のお知らせが一度に対象になり、消し終わるまで何回かの実行（毎分）にかかる。これを受け入れる。
- 30日より前の誘い・予定を指すお知らせはなくなる（お知らせを開いて「見つかりませんでした」になるのは、30日の境目の前後だけ）。

### 4. 流れないままの通知の記録
- `NOTIFICATION_START_AT` が未設定の間（T-07。今の staging・prod）、通知だけの型（`NOTIFICATION_ONLY_TYPES`）の outbox の行は、流れず処理済みにもならない。T-12 の掃除は処理済みの行しか消さないので、誰が誰の誘いを断ったかなどが残り続ける。
- 未設定の間は、通知だけの型で、未処理で、作ってから30日を過ぎた行を消す（ちょうど30日の行は残る。1回に1000行。インデックス `outbox_unprocessed (processed_at, created_at)`）。設定したあとは、その時刻より前の行は流さずに処理済みにする今の動き（T-07）のとおり。

### 5. 招待リンク
- 期限 `expires_at` が今から30日より前の行を消す（ちょうど30日の行は残る。使い切ったもの・無効化したものも、期限で消える。期限は最長7日。T-02）。1回に1000行。

### 6. くり返しの例外
- `local_date` が、UTC の今日の2日前の日付より前の行を消す（日付の当日・翌日・翌々日は残る）。タイムゾーンの差は最大1日なので、どのタイムゾーンでも過去の日付になっている。表示は、終わっていない枠と今日以降の例外しか使わないので変わらない。1回に1000行。
- ルールを消すと、例外は CASCADE で消える（今のまま）。

### 7. 公開設定
- 友達を解除する batch（T-02。social の `apps/api/src/social/infra/repository.ts` の `deleteFriendship`）で、両方向の「見せる」の行を消す。
  ```sql
  DELETE FROM sharing_policies
  WHERE visible = 1 AND ((owner_id = ?1 AND target_id = ?2) OR (owner_id = ?2 AND target_id = ?1))
  ```
- 「見せない」の行は消さない。退会で、両方向の行が消える（今のまま。T-16）。
- 文を持つのは availability：`sharing_policies` に触るのは `apps/api/src/availability/application/sharing.ts` の関数だけなので（T-02「前提」）、そこに文を返す関数（`unfriendPurgeSharingStatements(d1, userId, friendId)`）を足し、social が友達の行を消す文と同じ batch に入れる（T-16 の `withdrawalPurgeSharingStatements` を identity の退会の batch に入れたのと同じ形）。D1 の文で batch を組む。
- 友達に戻ったとき：「見せる」だった相手は行がないので初期値（見せる）。「見せない」だった相手は行が残っているので、見せないまま（T-02 決定事項5）。たとえば、見せないにされた側が解除して、同じ招待リンクで戻っても、見えないまま。
- 自動の「今回は難しい」の判定（`viewersWhoCanSee`。T-06 決定事項15）は、友達関係の作成時刻でも見ているので、解除して戻った相手は、戻った時刻より前の取り消しでは見られない側のまま（変わらない）。

### 8. 休眠中の連携
- **休眠の条件**（`?now` は今、`?cutoff` は今から30日前）：
  - 使える更新用トークンがない：
    `NOT EXISTS (SELECT 1 FROM sessions s JOIN refresh_tokens rt ON rt.session_id = s.id WHERE s.user_id = c.user_id AND s.revoked_at IS NULL AND s.expires_at > ?now AND rt.used_at IS NULL AND rt.expires_at > ?now)`
  - かつ、最後に使ってから30日を過ぎた：
    `NOT EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = c.user_id AND s.last_used_at >= ?cutoff)`
    （`last_used_at` は、ログインでセッションを作ったときと、更新用トークンで更新したときに書かれる。T-01。ちょうど30日前に使った人は休眠にならない。セッションの行がない人は、最後に使ってから30日を過ぎている）
  - ログアウト・失効だけでは、最後に使ってから30日たつまで休眠にならない。セッションの期限（90日）で更新用トークンが切れた人も、最後に使ってから30日以内なら休眠にならない。
- **休眠にする**：15分ごとの Cron（`CRON_CALENDAR_SYNC`。「9.」）で、1回に100行まで。
  ```sql
  UPDATE calendar_connections
  SET dormant_since = ?now, busy_snapshot = NULL, snapshot_from = NULL, snapshot_to = NULL, last_synced_at = NULL,
    large_change_held = 0, sync_lease_until = NULL, sync_id = ?newSyncId, updated_at = ?now
  WHERE rowid IN (
    SELECT c.rowid FROM calendar_connections c
    WHERE c.status = 'active' AND c.dormant_since IS NULL
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.withdrawn_at IS NULL)
      AND （使える更新用トークンがない）
      AND （最後に使ってから30日を過ぎた）
    LIMIT 100
  )
  ```
  - 退会した人（`withdrawn_at` がある）の連携は休眠にしない（T-16 の後始末で消える）。
  - 更新用トークンと `calendar_id` は残す。
  - `sync_lease_until = NULL` と新しい `sync_id`（1回の実行で1つの新しい値。`syncGuard` は利用者・プロバイダと組で見るので、行ごとに変えなくてよい）で、休眠にする前に始まっていた確認が、あとから記録を書いたり、ここ暇を取り消したりしないようにする（下の「休眠中」）。
- **休眠中**：
  - 定期の確認の割り当て（`connectionsDueForSync`）は `dormant_since IS NULL` の行だけ（「データ」のインデックスの範囲で外れる）。Google の埋まりの取得、ここ暇の自動の取り消し（T-06）、そこからの自動の「今回は難しい」が止まる。
  - 休眠にする前に割り当てた確認が、あとから届いても書かない。確認の権利を取る `takeSyncLease`、記録を進める `advanceSnapshotStatement`、保留の `holdLargeChange`（どれも `apps/api/src/calendar/infra/repository.ts`。呼ぶのは `apps/api/src/calendar/application/sync.ts` の `syncConnection`）の WHERE に `dormant_since IS NULL` を足す。休眠中は権利が取れず（`skipped`）、休眠にする前に権利を取っていた確認は、権利の値が NULL になっているうえ休眠の条件でも外れて、記録を進められない。取り消しの文は同じ batch の `syncGuard`（記録を進めたときの `sync_id`）の条件付きなので、走らない。
  - 止まらないもの：成立した予定の書き込み（`activeConnectionsOf`。友達が休眠中の人と予定を作れば、その人のカレンダーに書く）。そのとき Google の更新用トークンが切れていれば、今の扱い（`needs_reauth`。T-06）になる。
  - 受け入れること：休眠中は、カレンダーで埋まった時間のここ暇（くり返しは毎週展開されるので、とくに）が、友達に空いているように見えることがある。誘いは届くが、本人はアプリを開いていない。
- **戻す（ログイン）**：ログインでセッションを作る batch（`apps/api/src/identity/infra/repository.ts` の `createSessionRows`）で、セッションの INSERT の直後に、その利用者の連携を戻す文を入れる。セッションの行ができたときだけ書く（退会した人にはセッションを作らないので、戻さない）。文は calendar の application が返す（`wakeConnectionsStatement(d1, userId, sessionId)`。identity から呼ぶ）。
  ```sql
  UPDATE calendar_connections
  SET dormant_since = NULL, busy_snapshot = NULL, snapshot_from = NULL, snapshot_to = NULL, last_synced_at = NULL,
    large_change_held = 0, sync_lease_until = NULL, sync_id = ?newSyncId, updated_at = ?now
  WHERE user_id = ?userId AND dormant_since IS NOT NULL
    AND EXISTS (SELECT 1 FROM sessions WHERE id = ?sessionId)
  ```
  - 埋まりの記録の列も NULL にするので、次の確認は「記録だけ」から始まる（T-06 の確認の手順3）。休眠の間に入った予定で、ここ暇がまとめて取り消されることはない。`last_synced_at` が NULL なので、次の割り当てで先に選ばれる。
  - アプリを開いて更新用トークンで更新したときは戻さない（使えるトークンがあるので、休眠になっていない）。
  - 連携し直し（`saveConnection`）でも `dormant_since = NULL` にする（解除・Google 側の失効のあとに、休眠の印が残らないように）。
- **戻す（定期の確認の取りこぼし）**：休眠にするのと同じ15分ごとの Cron で、逆の向きも見る。`dormant_since` があるのに、使える更新用トークンがあり、かつ最後に使ってから30日以内の連携を戻す（1回に100行まで。書く値はログインのときと同じ）。
  ```sql
  UPDATE calendar_connections SET （ログインのときと同じ）
  WHERE rowid IN (
    SELECT c.rowid FROM calendar_connections c
    WHERE c.status = 'active' AND c.dormant_since IS NOT NULL
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id AND u.withdrawn_at IS NULL)
      AND EXISTS （使える更新用トークン。上の NOT EXISTS の中身）
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = c.user_id AND s.last_used_at >= ?cutoff)
    LIMIT 100
  )
  ```
  - どちらか片方だけ当てはまる連携（トークンはないが最近使った、など）は、休眠にも戻すにもならず、今の状態のまま。
- **読む量**：休眠にする文は、休眠でない active の連携をほぼすべて、1行ごとにセッションと更新用トークンをインデックス（`sessions_user_id`・`refresh_tokens_session_id`）で引いて読む（当てはまる行が少ないと、`LIMIT` で止まらない）。15分ごとなので、この読み取りを受け入れる。戻す文は、休眠中の行だけを読む（インデックスの `status`・`dormant_since` の範囲）。
- 退会した人の連携は、今のとおり扱わない（T-16）。

### 9. 掃除の書き方とログ
- 毎分の掃除：`apps/api/src/jobs/dispatch.ts` の `cleanupExpired` に足す。ほかの掃除と同じく `runStep` で1つずつ独立させる（T-12 データの増加）。step の名前：`cleanup_invitations`・`cleanup_broadcasts`・`cleanup_invite_links`・`cleanup_recurrence_exceptions`・`cleanup_stale_notification_outbox`。お知らせは今の `cleanup_notifications` の期間を変え、上限を付ける（「3.」）。
- 15分ごと：`apps/api/src/worker.ts` の `runScheduled` の `CRON_CALENDAR_SYNC`（`*/15 * * * *`）の分岐で、`assign_syncs` の前に、`runStep` で次を足す（休眠にした行を、同じ実行で割り当てないように）。
  - `mark_dormant_connections`：休眠にする（「8.」。100行）
  - `wake_dormant_connections`：取りこぼしを戻す（「8.」。100行）
  - `cleanup_push_subscriptions`：失効（`revoked_at IS NOT NULL`）か期限切れ（`expires_at <= ?now`）のセッションの購読を消す（1回に1000行）。セッションの掃除（T-01、#82）は利用者ごとに最初のセッションの行を残すので、その行の購読は CASCADE では消えない。ログアウト・失効では今もその場で消し、送るときにも使えない購読は消しているので（T-07）、残るのは、期限が切れたあと何も送られていない購読。送るときにはもともと使わないので、急がず15分ごとにする。`DELETE FROM push_subscriptions WHERE id IN (SELECT p.id FROM sessions s JOIN push_subscriptions p ON p.session_id = s.id WHERE s.revoked_at IS NOT NULL OR s.expires_at <= ?now LIMIT 1000)`（セッションの `sessions_revoked_at`・`sessions_expires_at` と、購読の `push_subscriptions_session` のインデックス）。
- SQL は各コンテキストに置く（invitation の infra：誘い・募集、social の infra：招待リンク、availability：例外は infra・公開設定は `application/sharing.ts`（「7.」）、notification の infra：お知らせ・購読、calendar の infra：休眠にする・戻す（ログインの文は application から identity に渡す）、jobs：outbox）。
- 上限いっぱいまで処理した（残っている見込み）ときは、どの step も `{ event: "cleanup_capped", step, count }` を出す（`count` は、その実行で消した行、または休眠にした・戻した行の数。件数だけで、ID は出さない。T-13 のログの一覧に足す）。

## 認可と秘匿
- 閲覧者IDの使い方：API がないので、閲覧者はいない。掃除はすべての利用者の行を、時刻と状態だけで選ぶ。ログインで休眠を戻すのは、そのセッションの利用者（本人）の連携だけ（`user_id = ?userId`）。
- 他人のデータに届かないことの保証：消すのは時刻と状態の条件に当たる行だけ。両方の参加者の履歴とお知らせが同じ30日で消えるので、片方だけに長く残って相手を推測させることはない。
- 公開設定：友達を解除しても「見せない」は残るので、見せないにした相手が解除して戻っても、ここ暇が見えるようにはならない（T-02 決定事項5）。消すのは「見せる」の行だけで、初期値と同じなので、見え方は変わらない。友達でない相手にはどちらにしても見えない（T-03 の「前提」の3条件）。
- 区別させない応答：変わらない（消えた誘い・予定は、ほかの見つからないものと同じ404）。休眠中の人も、友達からは今までどおりに見え、休眠かどうかは応答に出ない。
- ログ：件数と step の名前だけ。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 誘い：時間の終わりからちょうど30日の行は残り、それより前の行は消える。代わりの時間があれば、その終わりで判定する。状態によらない
- [ ] 誘い・募集を消すと、予定・参加者・宛先・.ics の鍵・リンクの参照も消え、両方の参加者の一覧・詳細から見えなくなる（404）
- [ ] 30日以内の誘い・募集と、まだ終わっていないものは消えない
- [ ] お知らせ：作ってからちょうど30日の行は残り、それより前の行は消える
- [ ] 通知の記録：`NOTIFICATION_START_AT` が未設定の間だけ、通知だけの型の未処理の30日より前の行が消える（ちょうど30日は残る）。設定されていれば消さない。ほかの型（カレンダーの型）の未処理の行は消さない
- [ ] 招待リンク：期限からちょうど30日の行は残り、それより前の行は消える。消えたリンクの無効化は404
- [ ] くり返しの例外：UTC の今日の2日前の日付の境界。ルールは残る
- [ ] 公開設定：友達を解除すると、両方向の「見せる」の行が消え、「見せない」の行は残る。「見せる」だった相手は、友達に戻ると「見せる」
- [ ] 公開設定：見せないにされた側が解除して、同じ招待リンクで戻っても見えないまま
- [ ] 公開設定：マイグレーションで、友達でない相手との「見せる」の行だけが消え、「見せない」の行と、友達との行は残る。退会では両方向の行が消える（T-16 の既存のテスト）
- [ ] 休眠にする：使える更新用トークンがなく、最後に使ってから30日を過ぎた人の連携は休眠になり、埋まりの記録が消え、`sync_lease_until` が NULL に、`sync_id` が新しい値になり、割り当てられない。最後に使ってからちょうど30日の人は休眠にならない
- [ ] 休眠にしない：トークンが使える人。ログアウト・失効しただけで、最後に使ってから30日以内の人。セッションの期限（90日）でトークンが切れたが、最後に使ってから30日以内の人。退会した人
- [ ] 休眠にした後に届いた確認は、記録を書かず取り消しもしない（休眠にする前に権利を取っていた確認、休眠にした後に権利を取ろうとした確認、保留の1回目の、どれも）
- [ ] 戻す（ログイン）：ログインでセッションを作ると、同じ batch で連携が戻り、埋まりの記録の列が NULL で、次の確認は記録だけ（ここ暇を取り消さない）。セッションができなかったとき（退会した人）は戻さない。ほかの利用者の連携は変わらない
- [ ] 戻す（取りこぼし）：`dormant_since` があり、使えるトークンがあって最後に使ってから30日以内の連携は、15分ごとの実行で戻る。片方だけ当てはまる連携は変わらない
- [ ] 連携し直すと `dormant_since` が NULL になる。休眠中も成立した予定は書き込む
- [ ] プッシュの購読：失効か期限切れのセッションの購読が消え（利用者の最初のセッションの行の分も）、使えるセッションの購読は残る
- [ ] 上限：誘い1000行・募集100行・お知らせ1000行・ほか1000行（休眠にする・戻すは100行、購読は1000行）まで処理し、残りは次の実行で処理される。上限いっぱいなら `{ event: "cleanup_capped", step, count }`
- [ ] インデックス：足した掃除（誘い・募集・お知らせ・招待リンク・例外・通知の記録・購読）と、休眠を入れた割り当ての SQL が、表全体を読まない（EXPLAIN QUERY PLAN。`apps/api/src/jobs/dispatch.test.ts` の既存の確かめ方）。休眠にする文は、インデックスの範囲で読む（読む量は「8.」のとおり受け入れる）
- [ ] 独立：1つの掃除が例外を投げても、残りの掃除が走る（毎分・15分ごとの両方）
- [ ] 他人のIDでは取得・更新できない：API の追加はない。既存のテストが通る

### E2Eテスト（対象にする利用者の流れ）
- 対象なし。毎分・15分ごとの掃除と定期の確認の割り当て・ログインの中の処理だけで、画面の流れは変わらない（消えたあとの表示は、今の「見つからない」と同じ）。

## 実装PRで直すもの
- 要求定義書：「保存するデータを減らす」に保持期間の一覧（この仕様書）への参照、NF-08 に「成立の記録は今は残さない（#46）」。
- T-01：ログインでセッションを作る batch で、休眠中の連携を戻すこと。休眠の判定に `last_used_at` を使うこと。
- T-02：招待リンクの掃除と、期限から30日を過ぎたリンクの無効化が404になること（30行目・150行目の「期限切れでも204」）。友達の解除で「見せる」の公開設定を消すこと（61行目の `sharing_policies` の表の説明、107行目の「`sharing_policies` は消さない」を「『見せない』の行は消さない」に）。決定事項5（「自分の暇を見せる」の設定は、友達を解除しても残す）は変えず、「友達に戻っても以前の『見せない』が残る」はそのまま正しい。
- T-03：くり返しの例外の掃除。
- T-04：終わった予定を誘いの詳細から見られるのは30日まで（78行目）。スコープ外の期限切れの行の掃除（216行目）。
- T-05：誘い・募集・予定の保持（214行目）。
- T-06：休眠（判定・割り当ての条件とインデックス・埋まりの記録を消す・`takeSyncLease`・`advanceSnapshotStatement`・`holdLargeChange` の条件・戻し方・連携し直しで休眠を外す。261行目の「確認の割り当て」と、連携の行の節）。
- T-07：お知らせの保持を30日に、掃除に上限（217行目・486行目）。未設定の間の通知だけの型の行の掃除。使えないセッションの購読の15分ごとの掃除（232行目の近く）。
- T-08：参照の行は、誘い・募集の保持期間の掃除でも CASCADE で消える（91行目・234行目）。
- T-12 データの増加：掃除の一覧と step の名前（80行目・82行目）、スコープ外の「くり返しの例外」（127行目）と「#38 のうち、この仕様書で扱わない掃除」（130行目）。
- T-13：ログの一覧に `cleanup_capped`（`step`・`count`）。
- T-16：「残すもの」（68行目）に、誘い・募集・予定は終わってから30日で消えること。
- `calendar-integration` スキル：休眠中は確認しないこと。

## スコープ外
- 成立数の集計（NF-08。#46）・監査ログ（#41）。
- D1 のバックアップ（Time Travel）と、外部サービスに残るデータ（#89）。
- 退避キューを読む処理（T-13）。
- 休眠中の Google の許可を revoke すること（利用者と決めた。残す）。
- 退会した人の、ID だけの利用者の行（T-16 のとおり残す）。

## 確認事項（合意前に解消する）
- なし

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-22 | 下書き | pryusei/kokohima-app#38 の残り（利用者の回答：30日、休眠中は確認を止める、NF-08 は残さない） |
| 2026-11-22 | お知らせを30日に、休眠の判定を使える更新用トークンにし、休眠で埋まりの記録を消して状態の列で割り当てから外す、公開設定を解除で消す、流れないままの通知の記録の掃除、`ics_tokens (meetup_id)` のインデックス、募集の上限を100、保持期間の表の値と抜けを直す、直す文書を足す | 仕様書PRの前のレビュー（セキュリティ・仕様）、利用者の回答 |
| 2026-11-22 | 公開設定は解除で「見せる」の行だけを消し「見せない」は退会まで残す（マイグレーションも。文は availability が持ち social の batch に入れる）、休眠の判定に最後に使った時刻（30日）を足す、休眠にするときに確認の権利と `sync_id` を変え、確認の文に `dormant_since IS NULL` を足す、ログインの batch で戻す・15分ごとに取りこぼしを戻す・退会した人を外す、休眠の処理を15分ごとの Cron に移して100行に、お知らせの掃除に上限、`cleanup_capped` を `count` にそろえる、使えないセッションの購読の掃除、保持期間の表（購読・連携の行）を直す、割り当てのインデックスを T-16 の条件に合わせて書き直す、境界のテストに「ちょうど30日は残る」、確認事項を決めたこと1に入れる | 仕様書PRのレビュー（pryusei/kokohima-app#108） |
