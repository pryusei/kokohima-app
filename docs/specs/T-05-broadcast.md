# T-05 仕様書：募集（暇な人いる？）

- 状態：下書き
- タスク票：docs/tasks/T-05-broadcast.md
- 関係する要件：F-11、F-13、F-14、要求定義書「状態遷移とビジネスルール」「ドメイン設計（Broadcast）」「悪用対策と運用」「認可と情報の秘匿」、未決事項「募集で名前が開示された後の『やっぱり行けない』の扱い」

## 概要
募集（Broadcast）は、選んだ友達への「この時間、暇な人いる？」。宛先の人は「応じる」だけを選べ、断る操作はない（応じなければ静かに終わる）。
応じた人の名前は、募集者が「決める」まで誰にも返さない。募集者に返すのは人数だけ。決めると、募集者と応じた人全員の成立した予定（Meetup）を作り、参加者どうしで名前を開示する。期限までに決めなければ、誰にも通知せず静かに終わる。

## 前提
- コンテキストは T-04 と同じ `invitation`。集約 `Broadcast` を足し、成立した予定（`meetups`・`meetup_participants`）は T-04 のものを使う
- 宛先は、作成時に両方向の `friendships` の行がそろっている友達だけ（T-04 と同じ SQL の条件）
- 時間・エリア・ひとこと・リンク・期限の規則は T-04 の誘いと同じ（`packages/shared` の Zod と invitation の domain の関数を共有する）
- 送信上限は T-04 の「直近24時間に20件」を、誘いと募集の合計で数える（1つの募集は宛先の人数にかかわらず1件）
- 状態遷移は条件付き UPDATE。同じ batch の後続の文は、T-04 と同じく遷移ごとの `transition_id` を `EXISTS` で確かめてから書く
- 外部連携（通知・カレンダー）は outbox にイベントを書くだけ（読む側は T-06・T-07）
- 相手の表示名とアイコンは identity の `getPublicProfiles` で取る。渡すのは、SQL で閲覧者が見てよいと絞った相手のIDだけ

## 用語（invitation-domain の用語表）
| 画面 | コード | 備考 |
| --- | --- | --- |
| 募集 | Broadcast | |
| 応じる／応じるのをやめる | Respond / Withdraw | 宛先の人の操作。断る操作はない |
| 決める | Decide | 募集の締め。応じた人全員に名前を開示する |
| 成立した予定 | Meetup | T-04 と共通 |
| やっぱり難しい | MeetupCancel（3人以上の予定では MeetupLeave） | 決定事項3 |

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/invitation.ts` に足す。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/broadcasts` | Bearer | JSON：`createBroadcastRequestSchema`（下記） | 201：`broadcastSchema`、`Location: /api/v1/broadcasts/{id}` | 400、404（宛先に友達でない人が含まれる）、429 `rate_limited` |
| GET | `/api/v1/broadcasts` | Bearer | query：`box`（`received`・`sent`。必須）、`limit`、`cursor` | 200：`{ items: broadcastSchema[], nextCursor }`（作成日時の新しい順） | 400 |
| GET | `/api/v1/broadcasts/{id}` | Bearer | なし | 200：`broadcastSchema` | 404（募集者でも宛先でもない） |
| POST | `/api/v1/broadcasts/{id}/responses` | Bearer | なし | 200：`broadcastSchema`（応じる。すでに応じていても200） | 404（宛先でない）、409 `invalid_state`・`expired` |
| DELETE | `/api/v1/broadcasts/{id}/responses/me` | Bearer | なし | 200：`broadcastSchema`（応じるのをやめる。応じていなくても200） | 404（宛先でない）、409 `invalid_state`・`expired` |
| POST | `/api/v1/broadcasts/{id}/decide` | Bearer | なし | 200：`broadcastSchema` | 404（募集者でない）、409 `invalid_state`（応じた人がいない・決定済み）・`expired` |
| POST | `/api/v1/meetups/{id}/cancel` | Bearer | なし | 200：`meetupSchema` | T-04 と同じ。3人以上の予定での動きは決定事項3 |

### 入力
- `createBroadcastRequestSchema`：`{ recipientIds, startsAt, endsAt, area, message, url, expiresIn }`（strict）
  - `recipientIds`：UUID の配列。1〜100人、重複なし。自分を含めない（含めたら400）
  - `startsAt`・`endsAt`・`area`・`message`・`url`・`expiresIn`：T-04 の `createDirectInviteRequestSchema` と同じ規則と既定値
- 応じる・やめる・決めるは本文なし（本文があっても読まない）
- `box`：`received`（自分が宛先）・`sent`（自分が募集者）。必須。`limit` は1〜50（既定20）

### 出力
- `broadcastSchema`（閲覧者が募集者か宛先かで中身を変えるが、項目はどちらも同じにする。値がない項目は `null`）：
  - `id`、`direction`（`sent`・`received`）、`owner`（募集者の公開プロフィール）
  - `status`：閲覧者から見た状態（「振る舞い」の表）
  - `startsAt`、`endsAt`、`area`、`message`、`url`、`expiresAt`、`createdAt`
  - `recipientCount`：宛先の人数。募集者には数を、宛先の人には `null`
  - `responseCount`：応じた人数。募集者には決める前から数を、宛先の人には `null`（決定事項2）
  - `respondedByMe`：宛先の人が応じているか。募集者には `null`
  - `meetupId`：閲覧者が参加者の成立した予定の `id`、なければ `null`
- 応じた人の名前・ID は `broadcastSchema` に入れない。決めた後は、成立した予定（`meetupSchema` の `participants`）で参加者だけが見られる

### 例外
- 宛先の中に友達でない人（存在しない・片方向の行しかない人を含む）が1人でもいれば、募集全体を404にする（どの人が友達でないかは返さない）
- 応じる・やめるは、状態を書き換える `PATCH` でなく、子リソース `responses` への `POST`／`DELETE`（自分の応答は `me`）にする
- 同じ時間の同じ宛先への重複は判定しない（宛先の組み合わせが募集ごとに違うため）。二重押しは画面でボタンを止めて防ぐ（`Idempotency-Key` は別タスク）

## データ
マイグレーション `apps/api/migrations/0005_broadcast.sql`。日時はUnixミリ秒。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `broadcasts` | `id`（UUID、PK）、`owner_id`（FK users、`ON DELETE CASCADE`）、`starts_at`、`ends_at`、`area`・`message`・`url`（null可）、`status`（`open`・`decided`）、`expires_at`、`decided_at`（null可）、`transition_id`（null可）、`created_at` | INDEX(`owner_id`, `created_at`, `id`)。`expired` は保存せず、読むときに決める |
| `broadcast_recipients` | `broadcast_id`（FK、`ON DELETE CASCADE`）、`user_id`（FK users、`ON DELETE CASCADE`）、`responded_at`（null可。応じた時刻）、`created_at` | PK(`broadcast_id`, `user_id`)、INDEX(`user_id`, `created_at`, `broadcast_id`) |
| `meetups` | `broadcast_id` 列を足す（FK broadcasts、`ON DELETE CASCADE`、UNIQUE、null可） | T-04 の `direct_invite_id` と同じく、どちらか一方だけが入る |
| `meetup_participants` | `left_at` 列を足す（null可。「やっぱり難しい」で抜けた時刻） | 決定事項3 |

- 応じるのをやめたら `responded_at` を `null` に戻す（応じた・やめたの履歴は残さない）
- 送信上限は、`direct_invites` と `broadcasts` の直近24時間の作成数の合計で数える

## 振る舞い

### 作成
- 判定の順番：入力の検証（400）→ 宛先が全員友達か（404）→ 送信上限（429）
- 宛先全員が友達であることと送信上限は、追加と同じ batch の中で判定する（`INSERT INTO broadcasts ... SELECT ... WHERE (宛先のうち両方向の友達の数) = (宛先の数) AND (直近24時間の誘い＋募集の数) < 20`。宛先の行と outbox は、募集の行があるときだけ書く）。0行なら判定の順番で読み直し、どれにも当てはまらなければ1回だけやり直す（T-04 の `attemptSend` と同じ）
- 返事の期限は T-04 と同じ（選んだ時間と開始日時の早いほう）
- outbox に `BroadcastSent`（`{ userIds: 宛先, broadcastId, actorId: 募集者, occurredAt }`）

### 状態
保存する状態は `open` と `decided` だけ。読むときに閲覧者ごとに次の状態を返す。

| 保存 | 時間 | 募集者に返す | 応じた宛先の人に返す | 応じていない宛先の人に返す |
| --- | --- | --- | --- | --- |
| `open` | 期限前 | `open` | `open` | `open` |
| `open` | 期限後 | `expired` | `closed` | `closed` |
| `decided` | — | `decided` | `decided` | `closed` |

- `closed`：宛先の人に「締め切りました」と出す状態。応じていない人には、決まったのか期限切れなのかを区別させない（決定事項4）。応じたのに決まらなかった人にも、期限切れと同じ `closed` を返す
- 決定の後、予定から抜けた人（決定事項3）には `closed` を返す

### 応じる・やめる
- 宛先の人だけ。`open` で期限前のときだけ（`UPDATE broadcast_recipients SET responded_at = ... WHERE ... AND EXISTS (SELECT 1 FROM broadcasts WHERE id = ? AND status = 'open' AND expires_at > ?)`）
- すでに応じている人がもう一度応じても、応じていない人がやめても200（冪等）。行の更新が0行で、状態が変わっていれば409 `invalid_state`、期限を過ぎていれば409 `expired`
- 友達の解除は、すでにある募集への応答を変えない（T-04 の決定事項6と同じ。解除が相手に伝わらないように）
- outbox には書かない（応じたことを、決める前に誰にも知らせないため。募集者の人数の表示は読み直しで変わる）

### 決める
- 募集者だけ。`open` で期限前、応じた人が1人以上のとき
- `UPDATE broadcasts SET status = 'decided', decided_at = ?, transition_id = ? WHERE id = ? AND owner_id = ? AND status = 'open' AND expires_at > ? AND EXISTS (応じた人)` のあと、同じ batch で予定・参加者（募集者と、その時点で応じている人全員）・`BroadcastDecided` を `transition_id` を確かめてから書く
- 0行なら読み直し、決定済みなら409 `invalid_state`、期限後なら409 `expired`、応じた人がいなければ409 `invalid_state`
- 決めた後に応じる・やめるは409 `invalid_state`
- outbox に `BroadcastDecided`（`{ meetupId, broadcastId, participantIds, occurredAt }`）。名前の開示の通知は T-07 がこのイベントで行う
- 予定の時間・エリア・ひとこと・リンクは募集のもの

### 期限切れと再募集
- 期限切れは保存せず、読むときに決める。通知しない（outbox にも書かない。要求定義書の `BroadcastExpired` は「状態のみ更新、通知なし」なので、イベントは作らない）
- 再募集：募集者の詳細で `expired` のとき「もう一度募集する」を出し、同じ宛先・時間（過ぎていれば空）・エリア・ひとこと・リンクを入れた作成画面を開く。新しい募集として作る（元の募集は変えない）

### 成立した予定の「やっぱり難しい」（決定事項3）
- 2人の予定（誘いから作った予定）は T-04 のまま：どちらかが押すと予定ごと `cancelled`
- 3人以上の予定（募集から作った予定）：
  - 押した人だけが抜ける（`meetup_participants.left_at` を書く）。ほかの参加者の予定は残る
  - 募集者が抜けたとき、または残りが1人になったときは、予定ごと `cancelled`
  - 抜けた人には、その予定は一覧に出ず、詳細は `cancelled` として返す
  - outbox に `MeetupLeft`（`{ meetupId, actorId, participantIds: 残った人, occurredAt }`）。予定ごと取り消したときは T-04 の `MeetupCancelled`
- 参加者の一覧（`participants`）には抜けていない人だけを返す

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）
- 誘いタブ（`/invites`）に「募集」を足す（受信・送信・募集・成立）。「募集」には自分の募集と受け取った募集を作成日時の新しい順に並べる
- 募集の作成（`/broadcasts/new`）：宛先（友達の一覧からチェック。初期値は全員）、日付と開始・終了（またはプリセット）、エリア、ひとこと、リンク、期限。誘いタブと友達タブから開ける
- 募集の詳細（`/broadcasts/{id}`）：
  - 募集者：時間などの内容、「n人が応じています」（0人なら「まだ応じた人はいません」）、1人以上なら「決める」。決めたら成立した予定へのリンク。`expired` なら「期限が過ぎました」と「もう一度募集する」
  - 宛先の人：募集者の名前と内容、`open` なら「応じる」（応じたら「応じるのをやめる」）、`decided` なら「成立」と予定へのリンク、`closed` なら「締め切りました」
  - 応じた人数・名前は宛先の人には出さない
- 成立した予定（`/meetups/{id}`）：参加者全員の名前。「やっぱり難しい」の動きは上のとおり
- 状態の表示は静かな灰色（成立だけ緑）。赤やエラー色を使わない
- 送れなかったときの文言は T-04 と同じ（429・404・400）

## 認可と秘匿
- 閲覧者IDの使い方：すべて `requireAuth` の閲覧者IDを使う。募集は `WHERE id = ? AND (owner_id = :viewer OR EXISTS (宛先に :viewer))`、応じる・やめるは宛先として、決めるは `owner_id = :viewer` で SQL で絞って取得・更新する
- 応答者の秘匿（要求定義書「認可と情報の秘匿」、invitation-domain の不変条件）：
  - 決める前は、応じた人の名前・ID をどの API でも返さない（募集者にも人数だけ）
  - 宛先の人には、ほかの宛先・応じた人数・応じた人の有無を返さない。宛先の人が受け取る `broadcastSchema` は、ほかの人の応答で形も値も変わらない（`recipientCount`・`responseCount` は常に `null`、`status` は自分の応答と時間だけで決まる。ただし決定の後は、応じた人には `decided` を返す）
  - 応じていない宛先の人には、決まったのか期限切れなのかを区別させない（`closed`）
  - 決めた後、名前を見られるのは成立した予定の参加者だけ
- 他人のデータに届かないことの保証：募集者でも宛先でもない人の募集・応答・決定は、存在しない場合と同じ404
- 送信の404：宛先に友達でない人が含まれるときは、どの人かを返さない
- ログ：ひとこと・エリア・URL・時刻・宛先のIDを出さない。outbox の payload は ID と `occurredAt` だけ

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] domain：閲覧者ごとの状態の表（募集者・応じた宛先・応じていない宛先 × open・期限後・decided・抜けた）、決められる条件、応じる・やめるの条件
- [ ] 作成：友達に送れる、201 と `Location`、宛先の行ができる、`BroadcastSent` の payload
- [ ] 作成の入力検証：宛先0人・101人・重複・自分を含む、時間・文字列・URL の規則（T-04 と同じ）
- [ ] 作成の404：宛先に友達でない人・存在しない人・片方向の行しかない人が1人でもいれば404で、募集も宛先の行も outbox もできない
- [ ] 送信上限：誘いと募集あわせて20件で429。募集は宛先の人数にかかわらず1件。同時に作っても上限を超えない
- [ ] 一覧：募集者の `sent`、宛先の `received`、作成日時の新しい順とカーソル、ほかの人の募集が出ない
- [ ] 秘匿：決める前、募集者の応答に名前・ID がなく人数だけ。宛先の人の応答は、ほかの人が応じても応じなくても完全に同じ（本文の一致で確かめる）
- [ ] 応じる・やめる：冪等、募集者の人数が増減する、期限後は409 `expired`、決定後は409 `invalid_state`、宛先でない人は404
- [ ] 決める：応じた人全員と募集者の予定ができ、参加者どうしで名前が見える。応じた人0人で409 `invalid_state`、期限後は409 `expired`、2回目は409 `invalid_state`、募集者でない人は404。`BroadcastDecided` の payload
- [ ] 同時に決める・応じる・やめる：決定は1回だけ、予定は1つ、参加者は決定の時点で応じていた人
- [ ] 決定後の状態：応じた人は `decided`、応じていない人は `closed`（期限切れと同じ）
- [ ] 期限切れ：通知（outbox）を書かない
- [ ] やっぱり難しい（3人以上）：抜けた人だけが予定から外れ、ほかの人には残る。募集者が抜けるか残り1人で `cancelled`。`MeetupLeft`／`MeetupCancelled`。2人の予定は T-04 のまま
- [ ] 他人のIDでは取得・更新できない：募集者でも宛先でもない人の詳細・応答・決定は404。宛先の人の決定、募集者の応答も404
- [ ] フロント：作成（宛先の初期値は全員、送れなかったときの文言）、募集者の人数の表示、宛先の人に人数を出さない、状態の静かな表示、再募集で内容が入る

### E2Eテスト（対象にする利用者の流れ）
- [ ] AがB・C・Dに募集 → BとCが応じる → Aには「2人が応じています」と出て名前は出ない → Aが決める → A・B・Cの「成立」に予定が出て、互いの名前が見える。Dには「締め切りました」
- [ ] Aが期限1時間の募集を作る → 誰も応じないまま E2E 環境の時計を1時間進める（決定事項5） → Aには「期限が過ぎました」と「もう一度募集する」、宛先の人には「締め切りました」。「もう一度募集する」で同じ宛先と内容の作成画面が開く
- [ ] 3人の予定でBが「やっぱり難しい」→ Bの「成立」から消え、AとCには残る

## スコープ外
- カレンダーへの登録（T-06）、通知（T-07。名前の開示の通知を含む）、OGP（T-08）
- 募集の取り下げ、決めた後の追加の参加、決めた後の時間の変更
- 同じ内容の重複送信の判定（Idempotency-Key とあわせて別タスク）
- 期限切れの行の掃除（Cron）
- 最終的な画面デザイン

## 決定事項（仕様書PRのレビューで合意）
1. 宛先は、作成時に友達の一覧から選ぶ（初期値は全員、1〜100人）。あとから宛先は変えられない
2. 宛先の人の操作は「応じる」「応じるのをやめる」だけ（断る操作はない）。応じた人数は募集者にだけ見せ、宛先の人には見せない
3. 募集から作った3人以上の予定での「やっぱり難しい」は、押した人だけが抜ける。募集者が抜けたとき、または残りが1人になったときは、予定ごと取り消す（要求定義書の未決事項への提案。実装PRで要求定義書の未決事項を閉じる）
4. 応じていない宛先の人には、決まったのか期限切れなのかを区別せず「締め切りました」と出す
5. E2E の期限切れの流れは、E2E 環境だけの時計の差し替え（`__e2e__` の経路で現在時刻を進める）を足して確かめる。本番のビルドに入らないことは T-01 と同じ方法で確かめる

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-17 | 初版 | T-05の仕様書PR |
| 2026-10-17 | 確認事項1〜5を提案どおり決定事項にした | 確認事項への回答 |
