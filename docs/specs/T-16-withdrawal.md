# T-16 仕様書：退会

- 状態：実装済み
- タスク票：docs/tasks/T-16-withdrawal.md
- 関係する要件：F-17、要求定義書のイベント表「UserWithdrew」、データの最小化。issue pryusei/kokohima-app#37

## 概要
- 利用者が設定のアカウントから退会できるようにする。直前にもう一度 Google でログインしてもらい、確認の画面のあと、その場で退会させる（取り消しの猶予は設けない）。
- 今の外部キーはどれも `ON DELETE CASCADE` なので、利用者の行を消すと、相手の誘い・募集・成立した予定まで消える。F-17 の「相手側の履歴は『退会したユーザー』と表示」と逆の動きになる（#37）。
- そこで、利用者の行は **ID だけを残した「抜け殻」** にし、本人のデータを消す。相手の履歴は残り、相手の画面には「退会したユーザー」と出る。
- 退会は2段に分ける。**入口を止める段**（要求の中で、1つの batch）で、ログイン・セッション・友達・本人の設定を消して、新しい書き込みと新しい誘いを止める。**後始末の段**（outbox の `UserWithdrew` を consumer で処理。失敗しても再試行で終わりまで進む）で、カレンダー・進行中の誘いと予定・書いた内容を片付ける。

## 決めたこと（利用者の回答）
1. 利用者の行は ID だけ残す（行ごと消して参照を空にする形にはしない）。
2. 退会した人が書いた、過去の誘い・募集の「ひとこと」「エリア」「リンク」は消す。
3. これからの成立した予定と、返事待ちの誘い・募集は「やっぱり難しい」と同じ扱いにする。
4. すぐに消す。同じ Google でまたログインすると、新しい利用者になる。
5. 退会の直前のログインを求める（10分以内にログインしたセッションだけが退会できる）。盗まれたアクセストークンなどで勝手に退会させられないように。
6. まだ決まっていない募集に応じていた人が退会しても、応じた人数は変えない。「決める」で予定を作るときに、退会した人を参加者から外す（募集者に、誰が応じていたかを推測させないため。T-05 の「決まる前は人数だけ」）。

## API
`api-conventions` に従う。動作なのでサブリソースの POST にする。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/me/withdrawal` | Bearer＋有効なセッション＋同じオリジン | body：`withdrawRequestSchema` `{ confirm: "withdraw" }` | 204（更新用トークン・結びつけ・招待の Cookie を消す） | 400 `validation_failed`（確認の値が違う）、401、403 `reauth_required`（セッションのログインが10分より前。本文に `reauthProvider`） |

- 退会させられるのは閲覧者本人だけ。経路にも本文にも利用者の ID を受けない。
- `requireAuth`・`requireActiveSession`・`requireSameOrigin` を通す。
- **直前のログイン**：閲覧者のセッションの `created_at`（ログインした時刻。更新用トークンの回転では変わらない）が、今から10分以内でなければ403 `reauth_required`。何も変えない。
- 確認の値 `"withdraw"` は、ほかの経路のつもりの要求や二重の押下で退会しないための目印。
- `Idempotency-Key` は受け付けない（T-10 決定事項2の対象外の表に足す。2回目はセッションがないので401になり、何も変わらない）。
- `GET /api/v1/me` は、退会した人（`withdrawn_at` あり）を404にする（T-01 の「404（退会の直後など）」）。
- 履歴の相手のプロフィール `historyProfileSchema`＝`publicProfileSchema`（T-02）＋`withdrawn: boolean` を足し、誘い・募集・予定・お知らせの DTO で使う。退会した人は `withdrawn: true` で、名前とアイコンは null。友達に関わる応答（友達の一覧・ここ暇・招待）は今の `publicProfileSchema` のまま（`withdrawn` を出さない）。T-15 の `avatarId` が先に入っていれば、その形に合わせる。項目の追加なので互換は壊れない。
- エラーの code に `reauth_required`（403）を足す（`api-conventions` スキルの表）。

## データ（マイグレーション：その時点の次の空いている番号）
- `users` に `withdrawn_at INTEGER`（NULL なら利用中）と `withdrawal_completed_at INTEGER`（後始末が終わった時刻）を足す。
- 外部キーの CASCADE は変えない（利用者の行を消さないので、相手の行は消えない）。

## 振る舞い

### 入口を止める段（`POST /me/withdrawal` の中。1つの batch）
D1 の batch は前の文の結果で後続を止められない（T-01）。どの文も何度実行しても同じ結果になる。`withdrawn_at` は最初の時刻を残す。
- `users`：`withdrawn_at` を今に（`COALESCE(withdrawn_at, ?)`）、`display_name`・`avatar_url`（T-15 なら `avatar_id`）・`email` を NULL、`timezone` を初期値に。
- 行を消す：`sessions`（更新用トークンも CASCADE で消える）、`user_identities`、`login_codes`、`invite_links`、`friendships`（両方向）、`sharing_policies`（両方向）、`presets`、`availabilities`、`recurrence_rules`（例外も）、`push_subscriptions`、`notification_preferences`、`notification_daily_counts`（本人の行）、`notifications`（本人あて）、`idempotency_keys`、`ics_tokens`、`calendar_oauth_states`、行きたい（本人の `wishes`。`wish_exclusions` と `link_preview_refs` の参照は CASCADE で消える。本人が見せない相手になっている `wish_exclusions`、本人の `wish_posts`。T-22。友達関係と同じ batch で消すので、相手からはすぐに見えなくなる）。
- outbox の本人だけに関わる行を消す：`type IN ('SessionStarted','CalendarConnected','CalendarReauthRequired','AvailabilityCancelledByCalendar','ContactMessageSubmitted') AND json_extract(payload, '$.userId') = ?`（処理済み・未処理とも。端末の情報やここ暇の時刻、問い合わせの内容が入るため。`ContactMessageSubmitted` は T-24。まだ届けていない問い合わせも届かなくなる）。
- outbox に `UserWithdrew` `{ userId, occurredAt }` を書く（後始末の段のきっかけ。dispatch の「常に流す型」に足す）。
- `calendar_connections` は、この段では消さない（後始末でカレンダーを消して revoke するのに、トークンが要る）。定期の確認と書き込みは、退会した人の連携を扱わない（下の「退会した人を扱わない処理」）。
- 応答で Cookie を消す。ログを `user_withdrew`（warn 未満の情報のログ。利用者の ID・メール・名前は出さない）で出す。

### 後始末の段（consumer で `UserWithdrew` を処理）
どの手順も何度呼んでも同じ結果になり、失敗したら投げて Queue の再試行に任せる。全部が終わったら `users.withdrawal_completed_at` を今にする。
1. **カレンダー**：連携があれば、「ここ暇」カレンダー（保存した `calendar_id`）を消し（T-06 の `deleteCalendar`。失敗しても続ける）、更新用トークンを revoke し（失敗しても続ける）、連携の行を消す。退会した人の Google カレンダーに、取り消した予定が残らないようにする。
2. **これからの成立した予定**：退会した人が参加者（抜けていない）で、開始が今より後（`starts_at > now`。開始ちょうどは触らない）の `confirmed` の予定ごとに、本人が「やっぱり難しい」を押したのと同じ遷移を行う（`cancelMeetup` を退会した人を閲覧者として呼ぶ。募集の予定は中で `leaveMeetup` に振り分けられる。T-04・T-05）。
   - 個別の誘いの予定：`cancelled` で `MeetupCancelled`。相手に定型文で知らせ、相手のカレンダーから消える。
   - 募集の予定：退会した人だけが抜けて `MeetupLeft`。ただし、退会した人が募集者のとき、または残りが1人以下になるときは、予定ごと `cancelled` で `MeetupCancelled`（T-05 決定事項3）。
3. **返事待ちの誘い**（期限前のものだけ。期限を過ぎたものは触らない）：
   - 退会した人が受信者の `pending`：「今回は難しい」と同じ遷移（`declined`、`DirectInviteDeclined`。送信者に知らせる）。
   - 退会した人が送信者の `pending`：新しい遷移「退会による打ち切り」で、期限 `expires_at` を今にする（`UPDATE direct_invites SET expires_at = ?now WHERE sender_id = ? AND status = 'pending' AND expires_at > ?now`）。通知なし。相手には期限切れに見え、「返事の期限」が退会した時刻になる。
   - 退会した人が送信者の `counter_proposed`（代わりの時間の開始前のものだけ）：決める人がいなくなるので `skipped` にする（`WHERE sender_id = ? AND status = 'counter_proposed' AND counter_starts_at > ?now` の条件付き UPDATE。通知なし）。受信者には「見送りになりました」と出る。
   - 退会した人が受信者の `counter_proposed`：触らない。`skipped` は送信者が見送った状態で、送信者に「見送りました」と事実と違う表示になるため。代わりの時間の開始で期限切れ（読むときに決まる）になり、それまでの送信者の「決める」は、退会した人を含むので409。
4. **募集**：退会した人が募集者で `open`：「退会による打ち切り」で期限を今にする（`UPDATE broadcasts SET expires_at = ?now WHERE owner_id = ? AND status = 'open' AND expires_at > ?now`）。通知なし。宛先の人には「締め切りました」。
   - 退会した人が宛先の人で応じていた募集は、応じた状態のまま残す（決めたこと6）。
5. **書いた内容**：退会した人が送信者の `direct_invites`、募集者の `broadcasts` の `area`・`message`・`url` を NULL に。その誘い・募集の `link_preview_refs` を消す（結果の行は T-08 の掃除で消える）。
- 2・3 は1回の処理で扱う数に上限（各100件）を付け、残っていれば投げて再試行で続きを進める（D1 の呼び出しの上限に当たらないように）。3〜5 は集合の SQL で行う。
- 最後の再試行でも終わらなければ退避キューに入る（T-13 の監視で気づく）。あわせて、毎分の掃除で「`withdrawn_at` から1時間を過ぎて `withdrawal_completed_at` が NULL」の利用者の後始末を、1回に5人まで直接呼び直す。
- 残すもの：誘い・募集・予定・参加者・宛先の行（相手の履歴）、相手あてのお知らせ（`actor_id` は退会した人の ID のまま）、相手に関わる outbox の行（処理済みの行は T-12 の掃除で消える）。誘い・募集・予定は、ほかの人のものと同じく、時間の終わりから30日で消え、お知らせも作ってから30日で消える（docs/specs/T-17-retention.md「2.」「3.」）。

### 退会した人を扱わない処理（同時の操作で、行が作り直されないように）
入口を止める段と同時に進んでいた要求や、あとで処理されるイベントが、抜け殻に本人のデータを作り直さないようにする。
- **予定ができる遷移**：`acceptInvite`（行く）、`decideAccept`（この時間で決める）の条件に、送信者と受信者のどちらも `withdrawn_at IS NULL` を足す。退会したあとは 409 `invalid_state`（今の「状態が変わった」と同じ）。募集の `decide` は、参加者を `withdrawn_at IS NULL` の応じた人だけにし、それが0人なら今の「応じた人が0人」と同じ 409。
- **ログイン**：`findOrCreateUser` のメールの更新、`saveLoginCode`、`createSessionRows` は `withdrawn_at IS NULL` の利用者だけ。`isSessionActive` と更新用トークンの確認は `users` を見て、退会した人なら無効。
- **カレンダー**：`saveConnection` は `withdrawn_at IS NULL` の利用者だけに書く（進行中の連携の callback が、抜け殻に連携を作り直さない）。書けなかったら、callback はコードと交換して受け取った更新用トークンを revoke してから失敗（`?calendar=failed`）にする（Google 側に許可を残さない）。定期の確認の割り当て（`assignSyncs`）と予定の書き込み（`activeConnectionsOf`）は、退会した人の連携を扱わない。
- **本人の表への書き込み**：`users` の表示名の更新、`presets`・`availabilities`・`recurrence_rules`・`notification_preferences`・`ics_tokens`・`idempotency_keys`・`push_subscriptions`・`invite_links`・`calendar_oauth_states` への書き込みは、`EXISTS (SELECT 1 FROM users WHERE id = ? AND withdrawn_at IS NULL)` の条件付き。`sharing_policies` と友達になる（`friendships`）は、両方の利用者が退会していないときだけ書く。
- **お知らせ**：退会した人あてのお知らせは作らない（今の `INSERT ... WHERE EXISTS users` の条件に `withdrawn_at IS NULL` を足す）。
- **リンクのプレビュー**：`insertRef` の条件に、誘い・募集の `url IS NOT NULL` を足す（書いた内容を消したあとに参照が作り直されないように）。
- **公開プロフィール**：`findPublicProfiles` は、`withdrawn_at` があれば列の値によらず名前とアイコンを null、`withdrawn: true` で返す。

### 退会のあとのアクセストークン
- アクセストークンは最長10分有効（T-01）で、退会しても手元に残る。
- 書き込みの経路は、すべて `requireActiveSession` を通す（セッションがないので401）。冪等キーの処理より前に置く。availability・invitation・notification・wish の経路は、`requireAuth` のあとに GET・HEAD 以外で確かめる `requireActiveSessionForWrites` をまとめて付ける。今 `requireAuth` だけで通っていた書き込みの経路：
  | context | 経路 |
  | --- | --- |
  | identity | `PATCH /me` |
  | social | `POST /invite-links/:id/revoke`、`DELETE /friends/:friendId`、`apps/api/src/social/routes.ts` のそのほかの POST |
  | availability | `PUT /me/presets`、`POST`・`DELETE /availabilities`、`POST`・`DELETE /recurrence-rules`、`POST`・`DELETE /recurrence-rules/:id/exceptions` |
  | invitation | `POST /direct-invites`、`POST /direct-invites/:id/responses`、`POST /direct-invites/:id/decide`、`POST /broadcasts`、`POST`・`DELETE /broadcasts/:id/responses(/me)`、`POST /broadcasts/:id/decide`、`POST /meetups/:id/cancel` |
  | calendar | `POST /meetups/:id/ics-links`。`GET /calendar/google/callback` は Bearer を持たない（state に結びつけた利用者で書く）ので、`saveConnection` の条件（`withdrawn_at IS NULL`）で止める |
  | notification | `POST /notifications/read`、`PATCH /me/notification-preferences`、`DELETE /push/subscriptions`（`POST /push/subscriptions` はもとから確かめる） |
| wish | `POST /wishes`、`PUT /wishes/:id/exclusions`、`DELETE /wishes/:id`（T-22） |
- 読み取りは、トークンが切れるまでの最長10分、自分の誘い・募集・予定の履歴（相手の ID・時刻、相手が書いたひとこと）が読める。本人がすでに受け取っていた内容なので受け入れる。`GET /me` は404。
- KV の埋まりのキャッシュ（`freebusy:v1:<userId>:...`）は、最長5分で切れるまで残る（受け入れる。T-10）。

### 相手の画面での表示
- 公開プロフィールは、退会した人を `withdrawn: true` で返す。`withdrawn` が出るのは、履歴の DTO（誘い・募集・予定の相手・参加者・宛先、お知らせの `actor`）だけ。
- 友達に関わる応答（ここ暇・友達の一覧・誘いの送り先）では、退会した人は友達でない人と区別できない（友達の行がないため。今の404などと同じ）。
- お知らせの `actor`：T-07 は相手が読めなければ `actor: null`（名前のない文言）にしている。退会した人は、`actor` を `withdrawn: true` のプロフィールで返し、文言は「退会したユーザー」にする（「〇〇さん」の「さん」は付けない。例：「退会したユーザーは今回は難しいみたい」）。もとから相手を持たないお知らせ（`meetup_cancelled`・`meetup_left` など）は今の文言のまま。
- Web は、`withdrawn` のとき名前の代わりに「退会したユーザー」と出す（「名前未設定の友達」とは区別する）。誘い・募集・予定・お知らせの一覧と詳細、`.ics` の本文のどれも同じ。赤やエラー色は使わない。
- 募集者の宛先の一覧では、退会した人も「退会したユーザー」と出るが、応じた人数は変わらない（決めたこと6）。

### 画面（設定のアカウント `/settings/account`）
- 「退会する」のボタンを、ほかの操作から離して置く（T-11 で作らなかった欄）。
- 押すと確認の画面：消えるもの（名前・ここ暇・友達・連携・お知らせ・書いたひとこと・行きたい）、相手の履歴には「退会したユーザー」と残ること、これからの予定は「やっぱり難しい」になること、取り消せないこと、直前にもう一度ログインすることを書く。「退会する」と「やめる」。
- 403 `reauth_required` なら、今と同じログインの方法へ移る（`returnTo=/settings/account?withdraw=1`）。別の方法でログインすると別の利用者になる（F-01）ので、方法は API が403 の本文の拡張の項目 `reauthProvider`（`google`・`apple`。ほかの方法なら null で、ログインの画面へ移す）で返す。戻ったら確認の画面をもう一度出す。確認の画面には今の表示名（「〇〇さんのアカウントを退会します」）を出し、違うアカウントで戻ってきたことに気づけるようにする。
- 204 なら：この端末のプッシュの購読をブラウザでも解除し（T-01 のログアウトと同じ）、手元のアクセストークンと TanStack Query のキャッシュを消して、ログインの画面に「退会しました。」と静かに出す。
- 401（応答が届かずに押し直した場合など）なら、ログインの画面へ（文言は出さない）。そのほかの失敗は「退会できませんでした。もう一度お試しください」（赤を使わない）。

## 認可と秘匿
- 閲覧者IDの使い方：退会させるのは閲覧者本人だけ。経路にも本文にも利用者の ID を受けない。直前のログインを求める。
- 他人のデータに届かないことの保証：消す行はどれも `user_id = 閲覧者`（友達・公開設定は両方向で閲覧者が片方）の条件で選ぶ。相手の行（誘い・予定の参加者・相手あてのお知らせ・相手の outbox の行）は消さない。
- 区別させない応答：友達に関わる応答では、退会した人は友達でない人と区別できない。履歴の相手が退会したことは分かる（F-17）。決まる前の募集で、応じていた人を推測させない（決めたこと6）。
- 受け入れるリスク：決まる前の募集で、応じていたのが退会した人だけのとき、募集者の「決める」は409（応じた人が0人と同じ）になる。募集者は人数と宛先の「退会したユーザー」から、応じていたのが退会した人だと推測できる。ほかに応じた人がいる場合も、決める前に見えていた人数と、決めたあとの予定の参加者の数が1人分ずれるので、宛先の「退会したユーザー」が応じていたと推測できる。どちらも、分かるのはもう退会した人のことだけなので受け入れる。
- 募集者の「決める」・誘いの「行く」「この時間で決める」は、どちらかが退会していたら予定を作らない（退会と同時に送られた要求でも）。
- 秘密の扱い：Google の更新用トークンは、カレンダーを消したあと revoke してから消す（T-06）。ログに利用者の ID・メール・名前を出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 入口を止める段：`users` が抜け殻（名前・メール・アイコンが NULL、`timezone` が初期値、`withdrawn_at` あり）。表の行が消え、相手の誘い・予定・参加者・宛先・相手あてのお知らせは残る。本人の outbox の行（`SessionStarted` など）が消え、相手の行は残る。`UserWithdrew` が書かれる。
- [x] 直前のログイン：セッションのログインが10分より前なら403 `reauth_required` で何も変わらない。10分以内なら退会できる。境界（ちょうど10分）。
- [x] 入力：確認の値がない・違うと400 `validation_failed` で何も変わらない。同じオリジンでなければ拒否。
- [x] 他人のIDでは取得・更新できない：経路に ID を渡す口がなく、ほかの利用者のデータ（その人の友達・ここ暇・お知らせ）は消えない。
- [x] カレンダー：連携していれば「ここ暇」カレンダーを消し、revoke し、連携の行が消える。どちらかが失敗しても後始末は終わる。
- [x] これからの予定：個別の予定は `cancelled` と `MeetupCancelled`。募集の予定は退会した人だけが抜けて `MeetupLeft`。退会した人が募集者のとき、残りが1人以下になるときは `MeetupCancelled`。開始ちょうど・開始後の予定、抜けた予定は触らない。
- [x] 返事待ち：受けた `pending` は `declined` と `DirectInviteDeclined`。送った `pending` は通知なしで期限切れ。`counter_proposed` はどちら側でも `skipped`（通知なし）。期限を過ぎた誘いは触らない。募集者の `open` の募集は期限切れ（宛先の人には `closed`）。
- [x] 書いた内容：退会した人が送った誘いと作った募集の `area`・`message`・`url` が NULL になり、リンクのプレビューの参照も消える。相手が送った誘いの内容は残る。
- [x] 後始末の再試行：1回で扱う件数の上限に当たると投げ（`withdrawal_completed_at` は入らない）、次の試行で終わりまで進んで入る（受けた誘いを上限より多く作って確かめる）。カレンダーの削除・revoke の失敗では投げずに終わる。毎分の掃除が、1時間を過ぎて終わっていない後始末を呼び直す。
- [x] 予定ができない：退会のあと、相手の「行く」（受けていた誘い）・「この時間で決める」が409で、予定ができない。応じていたのが退会した人だけの募集の「決める」は409。ほかに応じた人がいれば、退会した人を除いて予定ができる。退会の前後で、募集者に返る応じた人数が変わらない。
- [x] 同時の操作：退会のあとに、古い利用者で進んでいたログインの完了・カレンダーの連携の callback・表示名の更新・ここ暇の追加をしても、行が作り直されない。callback は失敗になり、受け取った更新用トークンを revoke する。
- [x] アクセストークン：退会のあと、同じアクセストークンで表の書き込みの経路がどれも401。更新用トークンでの更新も401。`GET /me` は404。
- [x] ログインし直し：同じ Google の `sub` でログインすると、新しい利用者 ID になる。403 の本文の `reauthProvider` は、閲覧者のログインの方法（Apple なら `apple`）。
- [x] 相手の表示：公開プロフィールが `withdrawn: true`（列に名前が残っていても null）。友達の一覧・「みんな」から消え、誘いは404。退会した人の ID を `actor_id` に持つお知らせは残り、`actor` が `withdrawn: true` で返る。
- [x] 退会した人を扱わない処理：退会のあとに処理されたイベントから、退会した人あてのお知らせを作らない。定期の確認とカレンダーの書き込みが、退会した人の連携を扱わない。書いた内容を消したあとに `LinkAttached` が処理されても、参照を作らない。
- [x] ログ：`user_withdrew` に ID・メール・名前が出ない。
- [x] Web：退会の確認の画面（今の表示名）、403 で今と同じ方法のログインへ移り（方法が分からなければログインの画面）、戻ってくると確認の画面をもう一度出す、204 でプッシュの購読の解除・トークンの消去・ログインの画面と「退会しました。」、401 でログインの画面、失敗の静かな文言。`withdrawn` の相手は「退会したユーザー」と出る（単体テストは誘いの一覧とお知らせ、予定は E2E。表示はどれも同じ関数 `nameOfProfile`・`honorificOf`）。

### E2Eテスト（対象にする利用者の流れ）
- [x] A と B が友達で、成立した予定と、B から A への返事待ちの誘いがある → A が設定から退会（直前にテスト用ログインでログインし直す）→ A はログインの画面に「退会しました」。outbox を処理すると、B の成立した予定は「やっぱり難しい」になって参加者に「退会したユーザー」と出て、お知らせに「退会したユーザーは今回は難しいみたい」と出る。B の友達一覧から A が消える（`e2e/withdrawal.spec.ts`）。

## 実装PRで直すもの
- 要求定義書：F-17 に「ID だけ残す」「書いた内容も消す」「進行中は『やっぱり難しい』と同じ」「直前のログイン」。イベント表の `UserWithdrew` を、後始末のきっかけで、相手への知らせは既存のイベント（`MeetupCancelled`・`MeetupLeft`・`DirectInviteDeclined`）で行う、に直す。
- T-01：アカウントの画面（退会）、ログインし直しは新しい利用者、`GET /me` の404、`requireActiveSession` の使い方（139行目）、ログイン・セッションの条件。
- T-02：公開プロフィールの `withdrawn`。
- T-04（90行目）・T-05（86行目）：`SET NULL` の検討を採らなかったことと、退会による打ち切り、`counter_proposed` の `skipped`、募集の `decide` で退会した人を外すこと。
- T-06（49行目）：退会の後始末の順番（カレンダーを消す→revoke→行を消す）、定期の確認で退会した人を扱わないこと。
- T-07（129行目）：お知らせの `actor` と文言、退会した人あてのお知らせを作らないこと。
- T-08（91行目・234行目）：参照が CASCADE で消える前提を、書いた内容を消すときに参照を消す形に。`insertRef` の条件。
- T-10：`POST /me/withdrawal` は `Idempotency-Key` の対象外。
- T-11：「23 アカウント」の退会の欄。
- `invitation-domain` スキル：用語表に「退会したユーザー」、状態遷移に「退会による打ち切り」と `counter_proposed` → `skipped`（退会）、イベント表に `UserWithdrew`。

## スコープ外
- 退会の取り消し・猶予期間。
- D1 のバックアップ（Time Travel）と、外部サービス（Resend の送信の記録、Google）に残るデータ（#89）。
- 成立数の集計（NF-08。#46）・監査ログ（#41）。作るときに退会の扱いを決める。
- 相手の Google カレンダーに残る、過去の予定のタイトル（相手のカレンダーの中身なので触らない。受け入れるリスク）。
- アカウント連携（#45）。

## 決定事項（仕様書PRのレビューで合意する）
1〜6は「決めたこと（利用者の回答）」のとおり。
7. 退会は2段に分ける。入口を止める段は要求の中の1つの batch、後始末の段は outbox の `UserWithdrew` を consumer で処理し、毎分の掃除で取りこぼしを拾う。相手への知らせは既存のイベントに任せる。（合意：仕様書PRのマージ）
8. 退会のあとのアクセストークンでの書き込みは、書き込みの経路すべてに `requireActiveSession` を通して止める。読み取りは、トークンが切れるまでの最長10分を受け入れる。（合意：仕様書PRのマージ）
9. 返事待ちの `counter_proposed` は `skipped`、送った `pending` と募集者の `open` の募集は「退会による打ち切り」（期限を今にする）で終える。通知は受けた `pending` の「今回は難しい」だけ。（合意：仕様書PRのマージ）→ 実装PRのレビューで、`skipped` にするのは退会した人が送信者のものだけにした（受信者が退会したものは、代わりの時間の開始で期限切れになる）。
10. 履歴の相手だけに `withdrawn` を出すため、プロフィールのスキーマを `publicProfileSchema`（友達向け）と `historyProfileSchema`（履歴向け）に分ける。（実装PR）

## 確認事項（合意前に解消する）
- なし（決定事項7〜9は仕様書PR pryusei/kokohima-app#105 のマージで合意）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-21 | 初版 | pryusei/kokohima-app#37 |
| 2026-11-21 | 2段に分ける（入口を止める段・後始末の段）、直前のログイン、決まる前の募集の人数を変えない、`counter_proposed` は `skipped`、募集の予定の取り消しの場合、同時の操作で行を作り直さない条件、outbox の本人の行を消す、退会した人のカレンダーを消す、書き込みの経路の一覧、`POST /me/withdrawal` に、`GET /me` の404、直す文書の追加 | 仕様書PRのレビュー（セキュリティ・仕様）、利用者の回答 |
| 2026-11-22 | 実装済みに。履歴の相手のプロフィールを分ける（決定事項10）、`reauth_required` の code、`requireActiveSessionForWrites`、カレンダーの callback は保存の条件で止める、書き込みの条件に招待リンク・連携の state・公開設定・友達になるを足す、お知らせの文言と E2E の確かめ方 | 実装PR |
| 2026-11-22 | 受信者が退会した `counter_proposed` は `skipped` にしない。退会と同時に進んだカレンダーの連携の callback は、保存できなければ受け取った許可を revoke して失敗にする。受け入れるリスクに参加者の数のずれを足す | 実装PRのレビュー（pryusei/kokohima-app#107） |
| 2026-11-23 | 「残すもの」の誘い・募集・予定とお知らせも、終わってから・作ってから30日で消えることを書いた | T-17 実装PR（docs/specs/T-17-retention.md） |
| 2026-11-23 | 入口を止める段で行きたい（`wishes`・`wish_exclusions`・`wish_posts`）を消す、wish の書き込みの経路を `requireActiveSession` の表に足す、確認画面の「消えるもの」に行きたい | T-22 実装PR（docs/specs/T-22-wishlist.md） |
| 2026-11-23 | 入口を止める段で消す outbox の型に `ContactMessageSubmitted` を足した | T-24 実装PR（docs/specs/T-24-contact.md） |
