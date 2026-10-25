# T-05 仕様書：募集（暇な人いる？）

- 状態：下書き（仕様書PRのレビュー待ち）
- タスク票：docs/tasks/T-05-broadcast.md
- 関係する要件：F-11、F-13、F-14、要求定義書「状態遷移とビジネスルール」「ドメイン設計（Broadcast）」「悪用対策と運用」「認可と情報の秘匿」、未決事項「募集で名前が開示された後の『やっぱり行けない』の扱い」

## 概要
募集（Broadcast）は、選んだ友達（2人以上）への「この時間、暇な人いる？」。宛先の人は「応じる」だけを選べ、断る操作はない（応じなければ静かに終わる）。
応じた人の名前は、募集者が「決める」まで誰にも返さない。募集者に返すのは人数だけ。決めると、募集者とその時点で応じている人全員の成立した予定（Meetup）を作り、参加者どうしで名前を開示する。
決まったかどうかは参加者にしか伝えない。応じていない宛先の人には、期限まで募集中のまま見せ、期限後は「締め切りました」と出す（決まった募集と期限切れの募集を区別させない）。

## 前提
- コンテキストは T-04 と同じ `invitation`。集約 `Broadcast` を足し、成立した予定（`meetups`・`meetup_participants`）は T-04 のものを広げて使う
- 宛先は、作成時に両方向の `friendships` の行がそろっている友達だけ（T-04 と同じ SQL の条件）
- 時間・エリア・ひとこと・リンク・期限の規則は T-04 の誘いと同じ（`packages/shared` の Zod と invitation の domain の関数を共有する）
- 送信上限は T-04 の「直近24時間に20件」を、誘いと募集の合計で数える。1つの募集は宛先の人数にかかわらず1件（宛先の上限100人と組み合わせて、一斉送信の量は抑えられる）
- 状態遷移は条件付き UPDATE。同じ batch の後続の文は、T-04 と同じく遷移ごとの `transition_id` を `EXISTS` で確かめてから書く
- D1 の1つの文に渡せる値は100個までなので、宛先のIDの一覧は JSON の配列1つとして渡し、SQL の中で `json_each` で展開する
- 外部連携（通知・カレンダー）は outbox にイベントを書くだけ（読む側は T-06・T-07）
- 相手の表示名とアイコンは identity の `getPublicProfiles` で取る。渡すのは、SQL で閲覧者が見てよいと絞った相手のIDだけ

## 用語（invitation-domain の用語表）
| 画面 | コード | 備考 |
| --- | --- | --- |
| 募集 | Broadcast | |
| 応じる／応じるのをやめる | Respond / Withdraw | 宛先の人の操作。断る操作はない |
| 決める | Decide | 募集の締め。その時点で応じている人全員に名前を開示する |
| 締め切りました | （画面の状態 `closed`） | 宛先の人に、決まったか期限切れかを区別させずに出す |
| 成立した予定 | Meetup | T-04 と共通 |
| やっぱり難しい | MeetupCancel（誘いの予定）／MeetupLeave（募集の予定） | 募集の予定では押した人だけが抜ける。イベント名は `MeetupLeft` |

- 実装PRで、invitation-domain スキルの用語表・状態・不変条件・イベントの表と、要求定義書の状態図（応じるのをやめる、決めた後の扱い）・ドメインイベントの表（`BroadcastSent`・`MeetupLeft` の追加、`BroadcastExpired` を作らないこと）・未決事項（「やっぱり行けない」を閉じる）を直す

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/invitation.ts` に足す。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/broadcasts` | Bearer | JSON：`createBroadcastRequestSchema`（下記） | 201：`broadcastSchema`、`Location: /api/v1/broadcasts/{id}` | 400、404（宛先に友達でない人・自分が含まれる）、409 `invalid_state`（やり直しても書けない）、429 `rate_limited` |
| GET | `/api/v1/broadcasts` | Bearer | query：`box`（`received`・`sent`。必須）、`limit`、`cursor` | 200：`{ items: broadcastSchema[], nextCursor }`（作成日時の新しい順） | 400 |
| GET | `/api/v1/broadcasts/{id}` | Bearer | なし | 200：`broadcastSchema` | 404（募集者でも宛先でもない） |
| POST | `/api/v1/broadcasts/{id}/responses` | Bearer | なし | 200：`broadcastSchema`（応じる） | 404（宛先でない）、409（「例外」） |
| DELETE | `/api/v1/broadcasts/{id}/responses/me` | Bearer | なし | 200：`broadcastSchema`（応じるのをやめる） | 404（宛先でない）、409（「例外」） |
| POST | `/api/v1/broadcasts/{id}/decide` | Bearer | なし | 200：`broadcastSchema` | 404（募集者でない）、409 `invalid_state`（応じた人がいない・決定済み）・`expired` |
| GET | `/api/v1/meetups`・`/api/v1/meetups/{id}` | Bearer | T-04 と同じ | `meetupSchema` に `broadcastId` を足す | T-04 と同じ |
| POST | `/api/v1/meetups/{id}/cancel` | Bearer | なし | 200：`meetupSchema` | T-04 と同じ。募集の予定では「抜ける」（「振る舞い」） |

### 入力
- `createBroadcastRequestSchema`：`{ recipientIds, startsAt, endsAt, area, message, url, expiresIn }`（strict）
  - `recipientIds`：UUID の配列。2〜100人、重複なし（決定事項7）
  - `startsAt`・`endsAt`・`area`・`message`・`url`・`expiresIn`：T-04 の `createDirectInviteRequestSchema` と同じ規則と既定値
- 応じる・やめる・決めるは本文なし（本文があっても読まない）
- `box`：`received`（自分が宛先）・`sent`（自分が募集者）。必須。`limit` は1〜50（既定20）

### 出力
- `broadcastSchema`（項目は閲覧者が募集者でも宛先でも同じにし、値がない項目は `null`）：
  - `id`、`direction`（`sent`・`received`）、`owner`（募集者の公開プロフィール）
  - `status`：閲覧者から見た状態（「状態」の表）
  - `startsAt`、`endsAt`、`area`、`message`、`url`、`expiresAt`、`createdAt`
  - `recipients`：宛先の公開プロフィールの配列。募集者には配列（自分で選んだ相手。再募集に使う）、宛先の人には `null`
  - `responseCount`：募集者には、決める前は今応じている人数、決めた後は決めた時点で予定に入った人数（あとで応じた・やめた人は数えない）。宛先の人には `null`
  - `respondedByMe`：宛先の人が今応じているか。募集者には `null`
  - `meetupId`：閲覧者がこの募集から作った予定の参加者（抜けた人を含む）ならその `id`、なければ `null`
- 応じた人の名前・ID は `broadcastSchema` に入れない。決めた後は、成立した予定（`meetupSchema` の `participants`）で参加者だけが見られる
- `meetupSchema`（T-04）に `broadcastId`（null可）を足す。項目の追加なので互換性は壊れない。募集から作った予定のエリア・ひとこと・リンクは募集のものを返す。`status` は閲覧者から見た値にする（抜けた人には `cancelled`）

### 例外
- 宛先の中に友達でない人（存在しない・片方向の行しかない人・自分を含む）が1人でもいれば、募集全体を404にする（どの人が友達でないかは返さない。自分を含めた場合も T-04 と同じく「友達でない」として404にそろえる）
- 応じる・やめるは、状態を書き換える `PATCH` でなく、子リソース `responses` への `POST`／`DELETE`（自分の応答は `me`）にする
- 応じる・やめるの409：予定の参加者でない宛先の人には、決まったかどうかを伝えないため、期限後は決まった募集でも期限切れの募集でも同じ409 `expired` にする（api-conventions の「状態が変わっていれば `invalid_state`」の例外）。予定の参加者（決めた時点で応じていた人）には409 `invalid_state`
- 同じ時間の同じ宛先への重複は判定しない（宛先の組み合わせが募集ごとに違うため）。二重押しは画面でボタンを止めて防ぐ（`Idempotency-Key` は別タスク）
- 作成が2回とも0行で、読み直してもどの理由にも当てはまらないときは409 `invalid_state`（T-04 の `attemptSend` と同じ）

## データ
マイグレーション `apps/api/migrations/0005_broadcast.sql`。日時はUnixミリ秒。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `broadcasts` | `id`（UUID、PK）、`owner_id`（FK users、`ON DELETE CASCADE`）、`starts_at`、`ends_at`、`area`・`message`・`url`（null可）、`status`（`open`・`decided`）、`expires_at`、`decided_at`（null可）、`transition_id`（null可）、`created_at` | INDEX(`owner_id`, `created_at`, `id`)。`expired`・`closed` は保存せず、読むときに決める |
| `broadcast_recipients` | `broadcast_id`（FK、`ON DELETE CASCADE`）、`user_id`（FK users、`ON DELETE CASCADE`）、`responded_at`（null可。今応じていればその最初の時刻）、`created_at` | PK(`broadcast_id`, `user_id`)、INDEX(`user_id`, `created_at`, `broadcast_id`) |
| `meetups` | `broadcast_id` 列を足す（FK broadcasts、`ON DELETE CASCADE`、null可） | SQLite の `ADD COLUMN` では UNIQUE を付けられないので、`CREATE UNIQUE INDEX meetups_broadcast ON meetups (broadcast_id)` を別に作る。`direct_invite_id` と `broadcast_id` のどちらか一方だけが入ることは、予定を作る文（誘いの決定・募集の決定）が片方しか書かないことで守る |
| `meetup_participants` | `left_at`（null可。「やっぱり難しい」で抜けた時刻）、`left_transition_id`（null可。抜けた遷移の値）を足す | 決定事項3 |

- 応じるのをやめたら `responded_at` を `null` に戻す（応じた・やめたの履歴は残さない）。応じている人がもう一度応じても `responded_at` は最初の時刻のまま
- 送信上限は、`direct_invites` と `broadcasts` の直近24時間の作成数の合計で数える
- 募集者が退会（利用者の削除）すると、募集と、募集から作った予定（3人以上でも）が CASCADE で全員の分まとめて消える。T-04 と同じく、退会のタスクで `SET NULL` などへの変更を検討する

## 振る舞い

### 作成
- 判定の順番：入力の検証（400）→ 宛先が全員友達か（404）→ 送信上限（429）
- 1つの batch で次を行う（宛先のIDは JSON の配列 `?r` 1つで渡す）
  1. `INSERT INTO broadcasts ... SELECT ... WHERE (SELECT COUNT(*) FROM json_each(?r) j WHERE 両方向の友達) = json_array_length(?r) AND (直近24時間の誘い＋募集の数) < 20`
  2. `INSERT INTO broadcast_recipients SELECT ?id, j.value, ?now FROM json_each(?r) j WHERE EXISTS (SELECT 1 FROM broadcasts WHERE id = ?id)`
  3. outbox に宛先ごとに1行の `BroadcastSent`（`INSERT INTO outbox SELECT ... FROM broadcast_recipients WHERE broadcast_id = ?id`）。payload は T-04 と同じく受け取り手1人の形 `{ userId: 宛先, broadcastId, actorId: 募集者, occurredAt }`
- 0行なら判定の順番で読み直し、どれにも当てはまらなければ1回だけやり直す（T-04 の `attemptSend` を誘いと募集で共通にする。募集には「同じ誘い」の判定がないので、その項目は常に偽）
- T-04 の誘いの送信（`insertInvite`・`diagnoseSend`）も、上限の件数と `Retry-After` の元になるいちばん古い送信を、`direct_invites` と `broadcasts` の両方から数えるように変える
- 返事の期限は T-04 と同じ（選んだ時間と開始日時の早いほう）

### 状態
保存する状態は `open` と `decided` だけ。読むときに、次の入力から閲覧者ごとの状態を domain の関数で決める：保存の状態、期限（`expires_at` と現在）、閲覧者の役割（募集者・宛先）、閲覧者が予定の参加者か（決めた時点で応じていたか）。

| 保存 | 期限 | 募集者 | 予定の参加者の宛先 | 参加者でない宛先（応じていない人、決めた後に応じた人） |
| --- | --- | --- | --- | --- |
| `open` | 期限前 | `open` | — | `open` |
| `open` | 期限後 | `expired` | — | `closed` |
| `decided` | 期限前 | `decided` | `decided` | `open`（決定事項6） |
| `decided` | 期限後 | `decided` | `decided` | `closed` |

- 参加者でない宛先の人に返す状態と値は、自分の応答と時間だけで決まり、ほかの人の応答や決定で変わらない（`responseCount`・`recipients`・`meetupId` は `null`、`respondedByMe` は自分の応答）
- 予定から抜けた参加者（決定事項3）にも `decided` と `meetupId` を返す（すでに決定と名前を知っているため）。予定の詳細は `cancelled` として返す
- 募集者が予定から抜けて予定が取り消されても、募集は `decided` のまま

### 応じる・やめる
- 宛先の人だけ。予定の参加者でない人は、保存の状態にかかわらず期限前（`expires_at > now`）なら受け付ける（決めた後でも受け付ける。決定事項6）
  - 応じる：`UPDATE broadcast_recipients SET responded_at = COALESCE(responded_at, :now) WHERE broadcast_id = ? AND user_id = :viewer AND EXISTS (SELECT 1 FROM broadcasts WHERE id = ? AND expires_at > :now) AND NOT EXISTS (この募集の予定の参加者に :viewer)`
  - やめる：同じ条件で `responded_at = NULL`
  - すでに応じている人が応じても、応じていない人がやめても200（期限前のときだけ。冪等）
- 決めた後に応じた人は、予定には入らない（期限後は `closed`。応じたのに決まらなかった募集と同じ）
- 0行なら読み直し、予定の参加者なら409 `invalid_state`（抜けるには「やっぱり難しい」を使う）、それ以外で期限後なら409 `expired`
- 友達の解除は、すでにある募集への応答を変えない（T-04 の決定事項6と同じ。解除が相手に伝わらないように）
- outbox には書かない（応じたことを、決める前に誰にも知らせないため）

### 決める
- 募集者だけ。`open` で期限前、今応じている人が1人以上のとき
- 1つの batch で次を行う（D1 の batch は1つのトランザクションなので、同時の応じる・やめるは、この batch の前か後のどちらかに入る）
  1. `UPDATE broadcasts SET status = 'decided', decided_at = :now, transition_id = :tid WHERE id = ? AND owner_id = :viewer AND status = 'open' AND expires_at > :now AND EXISTS (応じている宛先)`
  2. `meetups` に予定（`broadcast_id`、募集の時間）を、`broadcasts.transition_id = :tid` のときだけ書く
  3. `meetup_participants` に募集者と、その時点で `responded_at IS NOT NULL` の宛先全員を、予定の行があるときだけ書く
  4. outbox に `BroadcastDecided`（`{ meetupId, broadcastId, participantIds, occurredAt }`）と `MeetupConfirmed`（`{ meetupId, inviteId: null, broadcastId, participantIds, occurredAt }`）を、予定の行があるときだけ書く。`participantIds` は batch の中の SQL で `meetup_participants` から作る（`json_group_array`。アプリ側で先に読んだ一覧は使わない）
- 0行なら読み直し、決定済みなら409 `invalid_state`、期限後なら409 `expired`、応じている人がいなければ409 `invalid_state`
- イベントの読む側：T-06（カレンダー）は `MeetupConfirmed` を誘い・募集の両方で読む。T-07（通知）は名前の開示を `BroadcastDecided` で知らせ、`MeetupConfirmed` は `inviteId` があるときだけ通知に使う
- 予定の時間・エリア・ひとこと・リンクは募集のもの（`meetups` の一覧・詳細で `broadcasts` も JOIN して返す）

### 期限切れと再募集
- 期限切れは保存せず、読むときに決める。通知しない（outbox にも書かない。要求定義書の `BroadcastExpired` は「状態のみ更新、通知なし」なので、イベントは作らない）
- 再募集：募集者の詳細で `expired` のとき「もう一度募集する」を出し、作成画面を次の初期値で開く。新しい募集として作る（元の募集は変えない）
  - 宛先：元の宛先のうち、今も友達の人だけ（解除した人が残ると募集全体が404になるため）
  - 時間：開始が過ぎていれば空、過ぎていなければ元の時間
  - エリア・ひとこと・リンク：元のもの

### 成立した予定の「やっぱり難しい」（決定事項3）
- 規則は予定の作られ方で決める（参加者の人数では決めない）
  - 誘いの予定（`direct_invite_id` がある）：T-04 のまま。どちらかが押すと予定ごと `cancelled`
  - 募集の予定（`broadcast_id` がある）：押した人だけが抜ける。募集者が抜けたとき、または抜けた結果残りが1人以下になったとき（応じた人が1人だけの2人の予定を含む）は、予定ごと `cancelled`
- 募集の予定で抜ける batch
  1. `UPDATE meetup_participants SET left_at = :now, left_transition_id = :tid WHERE meetup_id = ? AND user_id = :viewer AND left_at IS NULL AND EXISTS (SELECT 1 FROM meetups WHERE id = ? AND status = 'confirmed' AND starts_at > :now AND broadcast_id IS NOT NULL)`
  2. `UPDATE meetups SET status = 'cancelled', cancelled_at = :now, transition_id = :tid WHERE id = ? AND status = 'confirmed' AND EXISTS (SELECT 1 FROM meetup_participants WHERE meetup_id = ? AND left_transition_id = :tid) AND ((SELECT owner_id FROM broadcasts WHERE id = meetups.broadcast_id) = :viewer OR (SELECT COUNT(*) FROM meetup_participants WHERE meetup_id = ? AND left_at IS NULL) <= 1)`
  3. 予定が `transition_id = :tid` で取り消されたときは `MeetupCancelled`（`participantIds` はこの遷移の前に抜けていなかった人全員。押した人を含む）、そうでなく抜けただけのときは `MeetupLeft`（`{ meetupId, actorId, participantIds: 残った人, occurredAt }`）。どちらか一方だけを、`EXISTS` で確かめて書く
- 同時に2人が抜けても、batch は1つずつ進むので、あとの batch の2で残りの人数が1以下になり、予定は確実に取り消される
- 0行なら読み直し、すでに抜けていれば409 `invalid_state`、予定が取り消し済みなら409 `invalid_state`、開始後なら409 `expired`
- T-04 の成立した予定のクエリも、抜けた人に合わせて変える
  - 一覧（`listMeetups`）：閲覧者が `left_at IS NULL` の予定だけ
  - 詳細（`findMeetupFor`）：抜けた人も読めるが、`status` は `cancelled` として返す
  - 参加者（`participantsOf`）：`left_at IS NULL` の人だけ
  - 誘いの予定の取り消し（`cancelMeetup`）：参加者の条件に `left_at IS NULL` を足す（誘いの予定では抜ける人はいないが、条件をそろえる）
  - T-04 の仕様書の `meetupSchema.status` の説明（閲覧者から見た値）も実装PRで直す

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）
- 誘いタブ（`/invites`）に「募集」を足す（受信・送信・募集・成立）。「募集」は「自分の募集」と「受け取った募集」の2つの一覧に分ける（API の `box` に合わせる）
- 募集の作成（`/broadcasts/new`）：宛先（友達の一覧からチェック。初期値は全員。友達が100人を超えるときは一覧の先頭から100人を選んだ状態で開き、「一度に送れるのは100人までです」と出す。1人以下では送れない）、日付と開始・終了（またはプリセット）、エリア、ひとこと、リンク、期限。誘いタブと友達タブから開ける
- 募集の詳細（`/broadcasts/{id}`）：
  - 募集者：内容、宛先の人数、「n人が応じています」（0人なら「まだ応じた人はいません」）、1人以上なら「決める」。決めたら成立した予定へのリンク。`expired` なら「期限が過ぎました」と「もう一度募集する」
  - 宛先の人：募集者の名前と内容、`open` なら「応じる」（応じたら「応じました」と「応じるのをやめる」）、`decided` なら「成立」と予定へのリンク、`closed` なら「締め切りました」
  - 応じた人数・名前・ほかの宛先は、宛先の人には出さない
  - 応じる・やめる・決めるで409になったら、最新の状態を読み直して表示し、静かな文言を出す
- 成立した予定（`/meetups/{id}`）：抜けていない参加者全員の名前。「やっぱり難しい」の動きは上のとおり（押すと確認なしで送る）
- 状態の表示は静かな灰色（成立だけ緑）。赤やエラー色を使わない
- 送れなかったときの文言は T-04 と同じ（429・404・400）

## 認可と秘匿
- 閲覧者IDの使い方：すべて `requireAuth` の閲覧者IDを使う。募集は `WHERE id = ? AND (owner_id = :viewer OR EXISTS (宛先に :viewer))`、応じる・やめるは宛先として、決めるは `owner_id = :viewer` で SQL で絞って取得・更新する
- 応答者の秘匿（要求定義書「認可と情報の秘匿」、invitation-domain の不変条件）：
  - 決める前は、応じた人の名前・ID をどの API でも返さない（募集者にも人数だけ）。宛先は2人以上（決定事項7）。2人とも応じたことが人数でわかるのは受け入れる
  - 予定の参加者でない宛先の人が受け取る `broadcastSchema` と、応じる・やめるの応答（本文とコード）は、ほかの人の応答と決定で変わらない（決定事項6）
  - 決めた後、名前を見られるのは成立した予定の参加者だけ
- 名前の開示は友達関係によらない：成立した予定の参加者どうしは、友達でなくても互いの公開プロフィールを見られる（F-11「決めるで応じた人全員へ名前を開示」。CLAUDE.md の「友達関係の条件を SQL に組み込む」の例外で、条件は「同じ予定の参加者であること」を SQL に組み込む）
- 他人のデータに届かないことの保証：募集者でも宛先でもない人の募集・応答・決定は、存在しない場合と同じ404
- 送信の404：宛先に友達でない人が含まれるときは、どの人かを返さない
- ログ：ひとこと・エリア・URL・時刻・宛先のIDを出さない。outbox の payload は ID と `occurredAt` だけ

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] domain：閲覧者ごとの状態の表（募集者・参加者・参加者でない宛先 × open 期限前／期限後・decided 期限前／期限後・抜けた参加者）、決められる条件、応じる・やめるの条件
- [ ] 作成：友達に送れる、201 と `Location`、宛先の行ができる、宛先ごとの `BroadcastSent`
- [ ] 作成の入力検証：宛先1人・101人・重複、時間・文字列・URL の規則（T-04 と同じ）。宛先100人で作れる
- [ ] 作成の404：宛先に友達でない人・存在しない人・片方向の行しかない人・自分が1人でもいれば404で、募集も宛先の行も outbox もできない
- [ ] 送信上限：誘いと募集あわせて20件で429（募集20件の後の誘い、誘い20件の後の募集の両方向）。`Retry-After` は両方の中でいちばん古い送信から計算する。募集は宛先の人数にかかわらず1件。同時に作っても上限を超えない
- [ ] 一覧：募集者の `sent`、宛先の `received`、作成日時の新しい順とカーソル、ほかの人の募集が出ない
- [ ] 秘匿：決める前、募集者の応答に名前・ID がなく人数だけ。参加者でない宛先の人の応答は、ほかの人が応じても応じなくても、決まっても決まらなくても、本文が完全に同じ（期限前・期限後の両方）
- [ ] 秘匿：参加者でない宛先の人の応じる・やめるのエラーは、決まった募集と期限切れの募集で本文とコードが同じ（409 `expired`）
- [ ] 応じる・やめる：冪等、`responded_at` は最初の時刻のまま、募集者の人数が増減する、期限後は409 `expired`、予定の参加者は409 `invalid_state`、宛先でない人は404、outbox に何も書かない
- [ ] 決めた後に応じる：期限前は200で受け付け、予定には入らず、募集者の人数も変わらない。期限後は `closed`
- [ ] 決める：応じた人全員と募集者の予定ができ、参加者どうしで名前が見える。予定のエリア・ひとこと・リンクが募集のもの。応じた人0人で409 `invalid_state`、期限後は409 `expired`、2回目は409 `invalid_state`、募集者でない人は404。`BroadcastDecided`・`MeetupConfirmed` の payload が参加者の行と一致する
- [ ] 同時に決める・応じる・やめる：決定は1回だけ、予定は1つ、参加者は決定の batch の時点で応じていた人で、payload と一致する
- [ ] 期限切れ：outbox を書かない
- [ ] やっぱり難しい（募集の予定）：抜けた人だけが外れ、ほかの人の一覧・詳細・参加者に残る。抜けた人には一覧に出ず、詳細は `cancelled`、もう一度押すと409 `invalid_state`。募集者が抜けるか残り1人以下で予定ごと `cancelled`（応じた人1人の2人の予定を含む）。同時に2人が抜けても取り消される。`MeetupLeft`／`MeetupCancelled` のどちらか一方だけ。誘いの予定は T-04 のまま
- [ ] 他人のIDでは取得・更新できない：募集者でも宛先でもない人の詳細・応答・決定は404。宛先の人の決定、募集者の応答も404
- [ ] E2E の経路：`__e2e__` の期限を過ぎさせる経路は `E2E_MODE` のときだけ有効で、募集者の募集にしか効かない。本番のビルドに `__e2e__` が入らない（CI の検査）
- [ ] フロント：作成（宛先の初期値は全員、100人を超えるとき、1人以下では送れない、送れなかったときの文言）、募集者の人数の表示、宛先の人に人数を出さない、状態の静かな表示、409 の読み直し、再募集で今も友達の宛先と内容が入る

### E2Eテスト（対象にする利用者の流れ）
- [ ] AがB・C・Dに募集 → BとCが応じる → Aには「2人が応じています」と出て名前は出ない → Aが決める → A・B・Cの「成立」に予定が出て、互いの名前が見える。Dには（期限前なので）募集中のまま出る
- [ ] AがB・Cに募集 → 誰も応じないまま、E2E 環境だけの経路で期限を過ぎた状態にする（決定事項5） → Aには「期限が過ぎました」と「もう一度募集する」、B・Cには「締め切りました」。「もう一度募集する」で同じ宛先と内容の作成画面が開く
- [ ] 3人の予定でBが「やっぱり難しい」→ Bの「成立」から消え、AとCには残る

## スコープ外
- カレンダーへの登録（T-06）、通知（T-07。名前の開示の通知を含む）、OGP（T-08）
- 募集の取り下げ、決めた後の追加の参加、決めた後の時間の変更
- 同じ内容の重複送信の判定（Idempotency-Key とあわせて別タスク）
- 期限切れの行の掃除（Cron）
- 退会したときの予定の扱い（退会のタスク）
- 最終的な画面デザイン

## 決定事項（仕様書PRのレビューで合意）
1. 宛先は、作成時に友達の一覧から選ぶ（初期値は全員、2〜100人）。あとから宛先は変えられない
2. 宛先の人の操作は「応じる」「応じるのをやめる」だけ（断る操作はない）。応じた人数は募集者にだけ見せ、宛先の人には見せない
3. 募集から作った予定での「やっぱり難しい」は、押した人だけが抜ける。募集者が抜けたとき、または残りが1人以下になったときは、予定ごと取り消す（要求定義書の未決事項への回答。実装PRで要求定義書の未決事項を閉じる）
4. 応じていない宛先の人には、決まったのか期限切れなのかを区別せず「締め切りました」と出す
5. E2E の期限切れの流れは、E2E 環境だけの経路で、ログイン中の閲覧者が募集者の募集の `expires_at` を過去にして確かめる（`POST /__e2e__/broadcasts/{id}/expire`。`E2E_MODE` のときだけ有効で、本番のビルドに入らないことを T-01 と同じ検査で確かめる）。当初はサーバーの時計を進める案だったが、並列で動くほかのテスト（誘いの期限、アクセストークンの有効期限）を壊すため、データを動かす方法にした
6. 予定の参加者でない宛先の人には、決めた後も期限までは募集中として見せ、応じるのも受け付ける（予定には入らず、期限後は「応じたのに決まらなかった募集」と同じ「締め切りました」）。決めた直後に「締め切りました」と出すと、期限前に締まったこと、つまり誰かが応じたことが伝わり、要求定義書の「募集の応答者の有無を区別させない」に反するため
7. 宛先は2人以上。宛先1人では、募集者に見える人数でその人が応じたかがわかるため（1人に送りたいときは個別の誘いを使う）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-17 | 初版 | T-05の仕様書PR |
| 2026-10-17 | 確認事項1〜5を提案どおり決定事項にした | 確認事項への回答 |
| 2026-10-17 | 仕様レビューを反映：決定の秘匿（決定事項6）、宛先2人以上（決定事項7）、応じる・やめるの409のそろえ方、作られ方で決める「やっぱり難しい」と抜ける batch、T-04 の予定のクエリの変更、募集の予定のエリアなど、閲覧者ごとの状態の入力、再募集の宛先（`recipients`）、`json_each` による宛先の受け渡し、誘いの送信上限の変更、outbox の payload（宛先ごとの `BroadcastSent`、SQL で作る `participantIds`、`MeetupConfirmed`）、UNIQUE INDEX、E2E の期限切れをデータを動かす経路に変更（決定事項5）、画面の一覧の分け方と409の読み直し、テストの追加 | 仕様レビュー、確認事項への回答 |
