# T-04 仕様書：個別の誘い（送信・返答・成立）

- 状態：実装済み
- タスク票：docs/tasks/T-04-direct-invite.md
- 関係する要件：F-10、F-12、F-13、F-14、F-15（URLの保存とドメインの表示まで）、要求定義書「状態遷移とビジネスルール」「ドメイン設計」「悪用対策と運用」、NF-03

## 概要
誘い（DirectInvite）は、友達1人への「この時間に会わない？」の提案。相手が見せてくれているここ暇と重なる時間なら「あそぼ」、重ならなければ「ここどう？」になる。
受け取った人は「行く」「今回は難しい」「この時間なら」の3つだけで返答する。行くと決まれば成立した予定（Meetup）を作る。断り・期限切れ・見送りは理由を残さず、静かに終わる。

## 前提
- コンテキストは `invitation`（`apps/api/src/invitation/{domain,application,infra}`）。状態遷移は集約 `DirectInvite`・`Meetup` のメソッドで決め、D1 の更新は `WHERE status = ?` の条件付きUPDATEにする
- 友達かどうかは、T-03 と同じく SQL の条件として両方向の `friendships` の行で判定する（`friendships` は読み取りだけ）
- 「あそぼ」の判定には、availability の application 層の `visibleSlotsFor(viewerId=送信者, friendId=相手, range)` を使う（T-03 の申し送り）。見せない設定の枠は判定にも使わない
- 相手の表示名とアイコンは identity の `getPublicProfiles` で取る。渡すのは、誘い・予定の参加者として SQL で絞った相手のIDだけ
- 外部連携（通知・カレンダー）は outbox にイベントを書くだけで、読む側は T-06・T-07
- 時刻の規則（15分単位、長さ30分以上24時間以下、60日先まで）は T-03 のここ暇と同じ。現在時刻によらない規則（15分単位・長さ・文字数・URLの形）は `packages/shared` の Zod に置き、現在時刻による規則（未来・60日以内・期限）は invitation の domain に置く（availability の domain は import しない）

## 用語（invitation-domain の用語表）
| 画面 | コード | 備考 |
| --- | --- | --- |
| 誘い | DirectInvite | `kind`：`asobo`（あそぼ）／`kokodou`（ここどう？） |
| 行く | Accept | 返答 `accept` |
| 今回は難しい | Decline | 返答 `decline`。理由は保存しない |
| この時間なら | CounterProposal | 返答 `counter`。代わりの開始〜終了つき |
| 決める／見送る | Decide（`accept`）／Skip（`skip`） | 「この時間なら」への送信者の決定。用語表の「決める」は募集の締めだけなので、実装PRで invitation-domain スキルの用語表・状態・イベントの表に足す |
| 成立した予定 | Meetup | |
| やっぱり難しい | MeetupCancel | 成立後の定型のキャンセル |

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/invitation.ts`。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/direct-invites` | Bearer | JSON：`createDirectInviteRequestSchema`（下記） | 201：`directInviteSchema`、`Location: /api/v1/direct-invites/{id}` | 400、404（相手が友達でない・自分）、409 `invalid_state`（同じ相手・同じ時間の返事待ちがある）、429 `rate_limited` |
| GET | `/api/v1/direct-invites` | Bearer | query：`box`（`received`・`sent`。必須）、`limit`、`cursor` | 200：`{ items: directInviteSchema[], nextCursor }`（作成日時の新しい順） | 400 |
| GET | `/api/v1/direct-invites/{id}` | Bearer | なし | 200：`directInviteSchema` | 404（参加者でない） |
| POST | `/api/v1/direct-invites/{id}/responses` | Bearer | JSON：`respondDirectInviteRequestSchema`（下記） | 200：`directInviteSchema` | 400、404（受信者でない）、409 `invalid_state`・`expired` |
| POST | `/api/v1/direct-invites/{id}/decide` | Bearer | JSON：`decideDirectInviteRequestSchema` `{ decision: "accept" \| "skip" }` | 200：`directInviteSchema` | 400、404（送信者でない）、409 `invalid_state`・`expired` |
| GET | `/api/v1/meetups` | Bearer | query：`limit`、`cursor` | 200：`{ items: meetupSchema[], nextCursor }`（これからの成立した予定。開始日時の古い順） | 400 |
| GET | `/api/v1/meetups/{id}` | Bearer | なし | 200：`meetupSchema` | 404（参加者でない） |
| POST | `/api/v1/meetups/{id}/cancel` | Bearer | なし | 200：`meetupSchema` | 404（参加者でない）、409 `invalid_state`（キャンセル済み）・`expired`（開始を過ぎた） |

### 入力
- `createDirectInviteRequestSchema`：`{ recipientId, startsAt, endsAt, area, message, url, expiresIn }`
  - `recipientId`：UUID
  - `startsAt`・`endsAt`：ISO 8601 UTC。15分単位、長さ30分以上24時間以下、`startsAt` は現在より後で、現在から60日以内
  - `area`：エリア。`null` か 1〜30文字（任意）
  - `message`：ひとこと。`null` か 1〜100文字（任意）
  - `url`：リンク。`null` か `http://`・`https://` で始まる2048文字以内のURL（任意。要求定義書のドメイン設計「Link（http/httpsのみ）」。OGPの取得は T-08）。URLとして解釈できない値、認証情報（`user:pass@`）を含む値は400
  - `expiresIn`：返事の期限。`"1h"`・`"3h"`・`"24h"`・`"until_start"`。省略したら `"until_start"`（決定事項1）
  - `area`・`message`：前後の空白を除き、NFCに正規化し、文字数はコードポイントで数える。制御文字・書式文字・私用領域などは T-02 の表示名と同じ規則で拒否する。ただし `message` は改行（`\n`。`\r\n` は `\n` にそろえる）を5個まで許す。空になったら `null` として扱う
- `respondDirectInviteRequestSchema`：次のどれか
  - `{ response: "accept" }`
  - `{ response: "decline" }`（理由の欄はない）
  - `{ response: "counter", startsAt, endsAt }`（代わりの時間。規則は送信と同じ。元の時間とまったく同じなら400）
  - どれも strict（`reason` などの余分な項目は400。断りの理由を受け取る口を作らない）
- `decideDirectInviteRequestSchema`：`{ decision: "accept" | "skip" }`（strict）
- `box`：`received`（自分が受けた）・`sent`（自分が送った）。必須で、なければ400。`limit` は1〜50（既定20）

### 出力
- `directInviteSchema`：
  - `id`、`kind`（`asobo`・`kokodou`）、`direction`（`sent`・`received`。閲覧者から見た向き）、`counterpart`（相手の公開プロフィール）
  - `status`：`pending`・`counter_proposed`・`confirmed`・`declined`・`skipped`・`expired`・`cancelled`（`expired` は保存せず、読むときに決める。「振る舞い」）
  - `startsAt`、`endsAt`、`area`、`message`、`url`、`expiresAt`
  - `counterProposal`：`{ startsAt, endsAt }` か `null`
  - `meetupId`：成立していればその予定の `id`、なければ `null`
  - `createdAt`
- `meetupSchema`：`{ id, startsAt, endsAt, status, participants, area, message, url, directInviteId, createdAt }`
  - `status`：`confirmed`・`cancelled`
  - `participants`：閲覧者以外の参加者の公開プロフィール
  - `area`・`message`・`url`：元の誘いのもの
- 値がない項目も省かず `null` を入れる（api-conventions）

### 例外
- 送信上限は429 `rate_limited` と `Retry-After`（直近24時間のうち、いちばん古い送信が24時間を過ぎるまでの秒数）。時間がたてば解ける制限なので429にする（T-03 の件数の上限は時間で解けないので409にした）
- 同じ相手・同じ開始〜終了の、まだ生きている返事待ちの誘い（`pending` で期限前、または `counter_proposed` で代わりの時間の開始前）がすでにある場合は409 `invalid_state`。期限切れになった同じ誘いがあっても送り直せる。`Idempotency-Key` は受け付けない（T-02 の決定事項6のとおり、KVとまとめて別タスク）ので、二重押しで同じ誘いが2つできるのをこの判定で防ぐ
- 成立した予定の一覧は、これからの予定（`ends_at > now`、`status = confirmed`）だけを返す。キャンセルした予定と終わった予定は、元の誘いの詳細から見る。並び順は開始日時の古い順、同じなら `id` の昇順で、カーソルにはこの2つを入れる

## データ
マイグレーション `apps/api/migrations/0004_invitation.sql`。日時はUnixミリ秒。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `direct_invites` | `id`（UUID、PK）、`sender_id`（FK users、`ON DELETE CASCADE`）、`recipient_id`（同）、`kind`、`starts_at`、`ends_at`、`area`、`message`、`url`（いずれも null可）、`status`、`expires_at`、`counter_starts_at`・`counter_ends_at`（null可）、`responded_at`・`decided_at`（null可）、`transition_id`（null可。直近の遷移の値）、`created_at` | INDEX(`sender_id`, `created_at`, `id`)、INDEX(`recipient_id`, `created_at`, `id`)、INDEX(`sender_id`, `recipient_id`, `starts_at`)（同じ誘いの判定）。`status` は `pending`・`counter_proposed`・`confirmed`・`declined`・`skipped`・`cancelled` |
| `meetups` | `id`（UUID、PK）、`direct_invite_id`（FK direct_invites、`ON DELETE CASCADE`、UNIQUE。募集の予定のため null可）、`starts_at`、`ends_at`、`status`（`confirmed`・`cancelled`）、`transition_id`（null可）、`created_at`、`cancelled_at`（null可） | INDEX(`starts_at`, `id`) |
| `meetup_participants` | `meetup_id`（FK、`ON DELETE CASCADE`）、`user_id`（FK users、`ON DELETE CASCADE`） | PK(`meetup_id`, `user_id`)、INDEX(`user_id`, `meetup_id`) |

- 断りの理由の列は作らない
- 退会したときの扱い（相手の履歴に「退会したユーザー」と出す）は退会のタスクで決める。今は利用者を削除すると、その人の誘いが消え、誘いから作った予定も `direct_invite_id` の CASCADE で一緒に消える（参加者の行も消える）。退会のタスクでは、FK を `SET NULL` に変えて履歴を残す方針を検討する

## 振る舞い

### 送信
- 送れるのは、両方向の `friendships` の行がそろっている相手だけ。友達でない人・存在しない人・自分は、どれも同じ404
- 判定の順番：入力の検証（400）→ 友達か（404。`visibleSlotsFor` が `null` を返したらこの時点で404）→ 同じ誘いが生きているか（409）→ 送信上限（429）。友達でない相手には、同じ誘いの有無や上限に関係なく404を返す（解除した元友達に、残っている誘いの有無を知らせない）
- `kind`：送信者から見えている相手の枠（`visibleSlotsFor(送信者, 相手, [startsAt, endsAt))`）のどれかと、誘いの開始〜終了が1分以上重なれば `asobo`、重ならなければ（接するだけを含む）`kokodou`。送信のときに決めて保存し、あとで相手がここ暇を変えても変えない
  - 相手が送信者に「見せない」にしている場合は、相手の枠は見えないので必ず `kokodou`。ここ暇がない相手と同じ結果になる
- 返事の期限 `expiresAt` は、`expiresIn` の時間を現在に足したものと開始日時の、早いほう（`until_start` は開始日時）。開始を過ぎてから返事をすることはない
- 送信上限：直近24時間に送った誘いが20件に達していたら429（決定事項2）。T-05 で募集を足すときは、誘いと募集をあわせて数える
- 友達であること、同じ誘いが生きていないこと、上限は、追加と同じ1つの文（`INSERT ... SELECT ... WHERE EXISTS(両方向の友達) AND NOT EXISTS(生きている同じ誘い) AND (直近24時間の件数) < 20`）で判定する。0行なら、上の判定の順番で読み直して404・409・429を返す。読み直したときにどの条件にも当てはまらない場合（読み直すまでの間に、同じ誘いの期限が切れた・いちばん古い送信が24時間を過ぎたなど）は、同じ INSERT を1回だけやり直し、それでも0行なら409 `invalid_state` を返す
- 直近24時間の件数には、状態にかかわらず送ったすべての誘いを数える（断られた・期限切れも含む）
- outbox に `DirectInviteSent` を、追加と同じ batch で、追加した誘いの行があるとき（`WHERE EXISTS (SELECT 1 FROM direct_invites WHERE id = :inviteId)`）だけ書く

### 状態遷移
```
pending ──accept──▶ confirmed ──やっぱり難しい──▶ cancelled
   │ ──decline──▶ declined
   │ ──counter──▶ counter_proposed ──decide accept──▶ confirmed
   │                      ├────decide skip────▶ skipped
   │                      └（代わりの時間の開始）▶ expired（保存しない。決定事項8）
   └（期限）▶ expired（保存しない）
```
- 返答（`responses`）は受信者だけ。決定（`decide`）は送信者だけ。参加者でない人には、存在しない場合と同じ404
- 返答できるのは `pending` で、期限前（`expires_at > now`）のときだけ。決定できるのは `counter_proposed` で、代わりの時間の開始前（`counter_starts_at > now`）のときだけ
- 更新は `UPDATE ... WHERE id = ? AND status = ? AND (時間の条件)` の条件付きにする。0行なら読み直し、保存した `status` で次のように判定する（api-conventions の判定の順）
  - 保存した `status` が、その操作に必要な状態（返答は `pending`、決定は `counter_proposed`、キャンセルは `confirmed`）でなければ409 `invalid_state`（例：`pending` への決定、`counter_proposed` への返答）
  - 必要な状態のままで、時間の条件を過ぎていれば409 `expired`
- batch の後続の文（予定・参加者・outbox の INSERT、元の誘いの UPDATE）は、`changes()` ではなく「この遷移で書いた状態が今そこにあるか」を `EXISTS` で判定して書く。`changes()` は直前の1つの文の行数だけを返すので、参加者2人を1つの INSERT で書くと次の文の `changes() = 1` が偽になるなど、文の並びと行数に依存して壊れるため
  - 遷移ごとにランダムな `transition_id` を UPDATE で書き、後続の文はそれを条件にする。例（返答の `accept`）：`WHERE EXISTS (SELECT 1 FROM direct_invites WHERE id = :inviteId AND status = 'confirmed' AND transition_id = :tid)`。同じ batch（トランザクション）の中なので、最初の UPDATE が効いたかどうかを確実に判定できる
  - 時刻の列（`responded_at = :now` など）で見分けると、同じミリ秒に届いた2つのリクエスト（同時の「行く」）を取り違え、予定が2つできかけるため、遷移ごとの値にした
  - 失敗した遷移では、後続の文はどれも何も書かない
- `accept`（返答）・`accept`（決定）：誘いを `confirmed` にし、成立した予定（`meetups`）と参加者2人（`meetup_participants`）を作り、outbox に `MeetupConfirmed`（`meetupId`・`inviteId`・参加者のID）を書く。これを1つの batch で行い、誘いの更新が0行なら後続の文も何もしない（上の `EXISTS` の書き方）
  - 予定の時間は、返答の `accept` なら誘いの時間、決定の `accept` なら代わりの時間
- `decline`：`declined` にする。理由は受け取らず、保存しない。outbox に `DirectInviteDeclined`
- `counter`：`counter_proposed` にし、代わりの時間を保存する。時間の規則は送信と同じ。「この時間なら」は1回だけ（`counter_proposed` からもう一度 `counter` はできない）。outbox に `DirectInviteCounterProposed`
- `skip`（見送る）：`skipped` にする。outbox に `DirectInviteSkipped`
- 期限切れ：保存した状態は変えず、読むときに次の場合を `expired` として返す。Cron での書き換えはしない。通知もしない（outbox に書かない）
  - `pending` で `expires_at <= now`
  - `counter_proposed` で `counter_starts_at <= now`（送信者が決めないまま、代わりの時間の開始を過ぎた。決定事項8）
- outbox のイベントの payload（T-02 の `FriendshipEstablished` と同じく、通知の受け取り手 `userId` と `occurredAt` を持つ。ひとこと・エリア・URL・時刻は入れない）
  - `DirectInviteSent`：`{ userId: 受信者, inviteId, actorId: 送信者, occurredAt }`
  - `DirectInviteDeclined`・`DirectInviteCounterProposed`：`{ userId: 送信者, inviteId, actorId: 受信者, occurredAt }`
  - `DirectInviteSkipped`：`{ userId: 受信者, inviteId, actorId: 送信者, occurredAt }`
  - `MeetupConfirmed`：`{ meetupId, inviteId, participantIds, occurredAt }`（通知とカレンダーの両方が読むので、受け取り手は参加者全員）
  - `MeetupCancelled`：`{ meetupId, actorId: キャンセルした人, participantIds, occurredAt }`
- 友達の解除は、すでにある誘いと予定を変えない（参加者は見られ、返答もできる）。解除で返答できなくなると、解除が相手に伝わってしまうため（F-09）

### 成立した予定
- 参加者だけが見られる。一覧はこれからの `confirmed` の予定を開始日時の古い順
- 「やっぱり難しい」（`cancel`）：参加者のどちらでも、`confirmed` で開始前（`starts_at > now`）なら `cancelled` にする（決定事項4）。元の誘いも同じ batch で `cancelled` にする（予定が `cancelled_at = :now` で `cancelled` になっているときだけ。上の `EXISTS` の書き方）。理由は受け取らない。outbox に `MeetupCancelled`
- 開始後で終了前の予定は一覧に出るが、キャンセルはできない（画面にボタンを出さない）
- キャンセルした後の再調整はしない（F-14）

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）
- タブに「誘い」を足す（みんな・ここ暇・誘い・友達）。誘いタブ（`/invites`）は「受信」「送信」「成立」の3つの一覧
  - 受信：相手の表示名、「あそぼ」／「ここどう？」、時間（「10/10（土） 19:00〜23:00」）、状態
  - 送信：同じ項目と状態
  - 成立：これからの成立した予定
- 状態の表示（赤やエラー色を使わない。断り・期限切れ・見送り・キャンセルは静かな灰色）：
  - `pending`：受信は「返事をしてください」、送信は「返事待ち」
  - `counter_proposed`：受信は「この時間ならと返しました」、送信は「この時間なら：10/10（土） 20:00〜23:00」
  - `confirmed`：「成立」
  - `declined`：送信者には「今回は難しいみたい」、受信者には「今回は難しいと返しました」
  - `expired`：「期限が過ぎました」
  - `skipped`：送信者には「見送りました」、受信者には「見送りになりました」
  - `cancelled`：「やっぱり難しくなりました」
- 表示名が未設定の相手は、T-02 と同じく「名前未設定の友達」と表示する
- 誘いの作成（`/invites/new`）：相手、日付と開始・終了（またはプリセット）、エリア、ひとこと、リンク、期限（1時間・3時間・24時間・開始まで）。相手の見えている枠と重なるかを画面でも表示し（「あそぼ」／「ここどう？」）、送った結果はサーバーの `kind` を正とする
  - 「みんな」の友達の枠から開くと、相手とその枠の時間を入れた状態で開く。開始は「現在より後の次の15分の区切り」と枠の開始の遅いほう、終了は枠の終了と「開始から24時間」の早いほう（「今から暇」の枠や、まとめて24時間を超えた枠でも、そのまま送れる時間にする）
  - 友達の詳細の「ここどう？と誘う」から開くと、相手だけを入れた状態で開く
  - 送れなかったときの文言（静かな灰色）：429は「今日はたくさん誘ったので、少し時間をおいてください」、409は「同じ時間の誘いをもう送っています」、404は「この友達には送れませんでした」、400は入力の欄ごとに直し方を出す
- 誘いの詳細（`/invites/{id}`）：受信者は返事待ちのとき「行く」「今回は難しい」「この時間なら」（代わりの開始・終了を選ぶ）。送信者は `counter_proposed` のとき「決める」「見送る」。リンクはドメインだけを表示する（OGPは T-08）。ドメインは `new URL(url).hostname`（国際化ドメインは punycode の `xn--...`）で表示し、文字の見た目による偽装（キリル文字の `а` など）を防ぐ。T-08 のカードの表示も同じ関数を使う
- 成立した予定（`/meetups/{id}`）：相手、時間、エリア、ひとこと、リンク。開始前なら「やっぱり難しい」（押すと確認なしで送る。デザイン原則「重い確認ダイアログを出さない」）
- 返答・決定・キャンセルは押したらすぐ表示を変え、失敗したら戻して静かな文言を出す（楽観的更新）。409 なら最新の状態を読み直して表示する

## 認可と秘匿
- 閲覧者IDの使い方：すべて `requireAuth` の閲覧者IDを使う。誘いは `WHERE id = ? AND (sender_id = :viewer OR recipient_id = :viewer)`、返答は `recipient_id = :viewer`、決定は `sender_id = :viewer`、予定は `meetup_participants.user_id = :viewer` を条件に含めて取得・更新する
- 他人のデータに届かないことの保証：参加者でない誘い・予定は、存在しない場合と同じ404。一覧は閲覧者が送信者か受信者のものだけ
- 区別させない応答：
  - 送信の404は、友達でない・存在しない・自分のどれも同じ
  - `kind` は見えている枠だけで決めるので、相手に「見せない」にされていることは `kind` からわからない（ここ暇がない相手と同じ `kokodou`）
  - 受信者には、送信者のここ暇は返さない（`kind` だけ）
  - 送信者には、断りの理由も、自動の断りかどうか（T-06）も返さない（どちらも `declined`）
- ログ：ひとこと・エリア・URL・誘いと予定の時刻・相手のIDを出さない
- outbox の payload は ID だけにし、ひとこと・エリア・URL を入れない（通知の文面は T-07 で、受け取る人が読める範囲から作る）

## テスト計画

### 単体テスト（実装PRで必須）
- [x] domain：状態遷移の表（許される遷移と、許されない遷移すべて。`pending` への決定、`counter_proposed` への返答を含む）、期限から `expired` を決める関数、`expiresAt` の計算（開始日時で頭打ち）、時刻の検証、`kind` の判定（1分以上の重なり、接するだけは `kokodou`）
- [x] 送信：友達に送れる。201 と `Location`、`counterProposal`・`meetupId` などが `null` でも項目が省かれない。`kind` が見えている枠で決まる（接するだけは `kokodou`）。相手が「見せない」のときは、ここ暇がない相手と同じ `kokodou`。送った後に相手がここ暇を変えても `kind` は変わらない
- [x] 送信の入力検証：過去・60日より先・15分単位でない・30分未満・24時間超、文字数の上限（コードポイント）、`http`・`https` 以外や認証情報つきのURL、制御文字、ひとことの改行（5個まで可、6個で400）、`expiresIn` の省略で `until_start`、`expiresAt` が開始日時で頭打ち
- [x] 送信の404：友達でない・存在しない・自分・片方向の行しかない相手が、どれも同じ応答。解除した元友達に、残っている同じ誘いと同じ時間で送っても409でなく404（判定の順番）
- [x] 送信上限：20件目まで送れ、21件目が429と `Retry-After`（いちばん古い送信が24時間を過ぎるまでの秒数）。断られた・期限切れの誘いも数える。24時間たてば送れる。同時に送っても20件を超えない
- [x] 同じ相手・同じ時間の生きている誘いは409。同時に2回送っても1つしかできない。期限切れになった同じ誘いがあっても送り直せる
- [x] 一覧：受信・送信の振り分け、作成日時の新しい順とカーソル、他人の誘いが出ない
- [x] 返答：`accept` で予定と参加者ができる、`decline`（`reason` を付けると400）、`counter`（時間の検証、元と同じ時間は400、2回目はできない）
- [x] 決定：`accept` で代わりの時間の予定ができる、`skip`
- [x] 期限：期限後の返答は409 `expired`、一覧と詳細で `expired`。代わりの時間の開始後の決定は409 `expired`
- [x] 状態が変わった後の返答・決定・キャンセルは409 `invalid_state`（`expired` より先に判定する）
- [x] 同時に返答（`accept` と `decline` など）しても、状態は1回だけ進み、予定は1つしかできない
- [x] 成立した予定：一覧（これからのものだけ、開始日時と `id` の順、カーソル）、詳細、「やっぱり難しい」（元の誘いも `cancelled`）、開始後は409 `expired`、2回目は409 `invalid_state`
- [x] batch の後続の文：成立で参加者が2行・outbox が1行書かれる。誘いの UPDATE が0行なら、予定・参加者・outbox はどれも0行。キャンセルで元の誘いと outbox が書かれ、2回目は何も書かれない
- [x] 送信の読み直しでどの条件にも当てはまらないとき、1回だけやり直す（やり直しで書ければ201、だめなら409 `invalid_state`）
- [x] フロント：リンクのドメインを punycode の `hostname` で表示する
- [x] outbox：遷移ごとのイベントが状態の更新と同じ batch で書かれ、payload が上の形で、ひとこと・エリア・URL・時刻を含めない。期限切れでは書かない。失敗した送信・遷移（404・409・429）では書かない
- [x] 友達を解除しても、既存の誘いの詳細が見られ、返答できる
- [x] 他人のIDでは取得・更新できない：参加者でない人の詳細・返答・決定・予定の詳細・キャンセルは404。受信者が決定、送信者が返答しても404
- [x] フロント：誘いの作成（「みんな」の枠からの初期値（開始が過去の枠・24時間を超える枠の丸め）、友達の詳細から相手だけが入る、「あそぼ」／「ここどう？」の表示、送れなかったときの文言）、返答の楽観的更新と失敗時の戻し、状態の静かな表示（赤を使わない）

### E2Eテスト（対象にする利用者の流れ）
- [x] AがBの見えている枠から誘う（「あそぼ」）→ Bが「行く」→ AとBの「成立」に予定が出る
- [x] AがCに、Cのここ暇がない時間で誘う（「ここどう？」）→ Cが「この時間なら」→ Aが「決める」→ 双方に成立
- [x] AがBに誘う → Bが「今回は難しい」→ Aの送信の一覧に「今回は難しいみたい」と静かに出る
- [x] 成立した予定で「やっぱり難しい」→ 双方の「成立」から消え、誘いの詳細に「やっぱり難しくなりました」

## スコープ外
- 募集（T-05）。送信上限への募集の算入は T-05 で行う
- カレンダーへの登録と .ics（T-06）。ここ暇の自動取り消しによる自動の断り（T-06。対象の条件と遷移は T-06 の仕様書で決める）
- 通知（T-07。outbox のイベントを読む）
- OGPの取得とカード表示（T-08）
- 返事待ちの誘いの取り下げ（決定事項5）、成立後の時間の変更（再調整しない。F-14）
- 期限切れの行の掃除（Cron）
- Idempotency-Key（KVとまとめて別タスク）
- 退会したユーザーの表示
- ひとことの不適切利用への対策（要求定義書の未決事項）
- 最終的な画面デザイン

## 決定事項（仕様書PRのレビューで合意）
1. 返事の期限の選択肢は「1時間・3時間・24時間・開始まで」とし、どれも開始日時で頭打ちにする。既定は「開始まで」（APIで省略したときも）
2. 送信上限の「1日20件」は、直近24時間の件数で数える（日付の切り替わりで一度にリセットしない）
3. 送信者には、断り（「今回は難しいみたい」）・期限切れ・見送りを区別して、どれも静かに表示する。理由は出さない
4. 「やっぱり難しい」は、成立した予定の開始前までできる（開始後は409 `expired`）
5. 「この時間なら」は1回だけ（返されたら送信者は決めるか見送るかだけ）。送信者は返事待ちの誘いを取り下げられない
6. 友達を解除しても、既存の誘いと予定はそのまま（返答もできる）。解除が相手に伝わらないようにするため
7. 誘いの開始は現在より後に限る（「今から」の誘いは、次の15分の区切りから）
8. 「この時間なら」を送信者が決めないまま、代わりの時間の開始を過ぎたら `expired` として返す。要求定義書の状態図にはない遷移だが、決める意味がなくなった誘いを返事待ちのまま残さないため。実装PRで、要求定義書の状態図と invitation-domain スキルの状態の欄に足す

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-08 | 初版 | T-04の仕様書PR |
| 2026-10-08 | 仕様レビューを反映：同じ誘いの判定から期限切れを除く、送信の判定の順番、outbox の条件付きの書き込みと payload、FK の CASCADE、`counter_proposed` への名前の変更、保存した状態での409の判定、URLに http を許す、ひとことの改行、作成画面の初期値と文言、テストの追加。確認事項を決定事項にした（8を追加） | 仕様レビュー、確認事項への回答 |
| 2026-10-08 | batch の後続の文を `changes()` でなく `EXISTS` で判定する、送信の読み直しで当てはまらないときの1回のやり直し、リンクのドメインを punycode で表示。決定事項8を合意。状態を合意済みにした | 仕様書PRのレビュー（pryusei/kokohima-app#13） |
| 2026-10-08 | batch の後続の文の判定を、時刻の列でなく遷移ごとの `transition_id` にした（同じミリ秒の同時の返答を取り違えないため）。状態を実装済みにした | 実装PR |
