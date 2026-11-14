# T-07 仕様書：通知（Webプッシュとメール）

- 状態：下書き
- タスク票：docs/tasks/T-07-notification.md
- 関係する要件：F-06、F-08、F-16、NF-02、NF-07、要求定義書の未決事項「通知の種別と頻度、メールにする通知、停止設定、自動取り消しのまとめ通知」、セキュリティ設計（新端末のログインのメール通知、通知メールにログイン用のリンクを入れない、SPF・DKIM・DMARC）

## 概要
各コンテキストが outbox に書いたイベントから、受け取り手ごとの「お知らせ」を作る。通知の中身はアプリのお知らせ一覧でだけ読む。
- **Webプッシュ**：中身のないプッシュ（VAPID の署名だけ）で「新しいお知らせがあります」と知らせる。押すとお知らせ一覧が開く（決定事項2）。相手の名前や誘いの内容は、プッシュのサービス（Apple・Google・Mozilla）に渡さない。
- **メール**：プッシュの購読がない人に、同じお知らせを中身なしで送る（決定事項3）。新端末のログインだけは、全員にメールで送る。
- **止める設定と上限**：種別ごとに止められ、1日の上限を超えた分は送らない（決定事項4）。どちらの場合もお知らせ一覧には残る。

## 前提

### コンテキスト
- コンテキストは `notification`（`apps/api/src/notification/{domain,application,infra}`）。
- 送るのは T-06 の outbox → Queue → consumer の流れ（`apps/api/src/jobs/`）。
  - `jobs/dispatch.ts` の `DISPATCHED_TYPES` に通知の型を足す。
  - `jobs/consumer.ts` から notification の application を呼ぶ。
  - T-06 の型（`MeetupConfirmed` など）は、カレンダーの書き込みと通知の両方で処理する（1つのメッセージで両方を呼ぶ。どちらも冪等）。
- ほかのコンテキストの表は読まない。
  - 相手の表示名は identity の `getPublicProfiles` で取る。
  - 募集者・予定の参加者などは invitation の application の関数で取る。
  - 「見せない」にするのは availability の `setSharing`（T-02 と同じく `PATCH /friends/{friendId}`）。

### 外部とのつなぎ方
- 外部呼び出しは `AppDeps.fetch` を通す。Resend とプッシュの宛先は、テストと E2E で差し替える。タイムアウトは5秒。
- メールの配信は Resend（決定事項1）。`POST https://api.resend.com/emails`、`Authorization: Bearer <RESEND_API_KEY>`。
  - `Idempotency-Key` にお知らせの ID を入れ、再試行で二重に送らない。
  - 既定の上限は1チームで1秒10件（429）。429・5xx は一時的な失敗として扱い、Queue で再試行する。
  - 公式のページは実装の最初に確かめる（このPRでは検索の結果で確かめた）。
- Webプッシュは RFC 8030 と RFC 8292（VAPID）。
  - 中身を送らないので、RFC 8291 の暗号化は実装しない。
  - 購読の `p256dh`・`auth` の鍵も受け取らず、保存しない。

### 古い outbox の行
T-06 より前から未処理のまま残っている通知の型の行は、作成から7日を過ぎていたら送らずに処理済みにする（決定事項5）。本番の運用前の行が一度にまとめて届かないようにするため。

### 実装PRで直すもの
- 要求定義書のドメインイベントの表と、未決事項「通知の種別と頻度…」を閉じる。
- invitation-domain スキルのイベントの表（「通知（T-07）」の書き方）。
- `MeetupConfirmed` と `BroadcastDecided` の payload に `actorId` を足す（「お知らせの作り方」。T-04・T-05 の仕様書も直す）。

## 用語
| 画面 | コード | 備考 |
| --- | --- | --- |
| お知らせ | Notification | 受け取り手1人ぶんの1件。一覧で読む |
| 通知の設定 | NotificationPreferences | 種別ごとのオン／オフ |
| プッシュの購読 | PushSubscription | 端末（ブラウザ）ごとに1つ |

## お知らせの作り方

### 種別と受け取り手
受け取り手は payload のIDから決める。手を下した本人（`actorId`）には送らない。

| イベント | 受け取り手 | 種別（設定の単位） | お知らせの種類 | 相手（`actor`） |
| --- | --- | --- | --- | --- |
| `DirectInviteSent` | `userId`（受信者） | `invites` | `invite_received` | 送信者 |
| `DirectInviteDeclined` | `userId`（送信者） | `invites` | `invite_declined` | 受信者 |
| `DirectInviteCounterProposed` | `userId`（送信者） | `invites` | `invite_countered` | 受信者 |
| `DirectInviteSkipped` | `userId`（受信者） | `invites` | `invite_skipped` | 送信者 |
| `BroadcastSent` | `userId`（宛先ごと） | `broadcasts` | `broadcast_received` | 募集者 |
| `BroadcastDecided` | `participantIds` から `actorId`（募集者）を除いた人 | `broadcasts` | `broadcast_decided` | 募集者 |
| `MeetupConfirmed`（`inviteId` があるときだけ） | `participantIds` から `actorId` を除いた人 | `meetups` | `meetup_confirmed` | 相手 |
| `MeetupCancelled` | `participantIds` から `actorId` を除いた人 | `meetups` | `meetup_cancelled` | なし |
| `MeetupLeft` | `participantIds`（残った人） | `meetups` | `meetup_left` | なし |
| `FriendshipEstablished` | `userId` | `friends` | `friend_added` | `friendId` |
| `AvailabilityCancelledByCalendar` | `userId` | `calendar` | `availability_cancelled`（`count`＝取り消した枠の数） | なし |
| `CalendarReauthRequired` | `userId` | `calendar` | `calendar_reauth` | なし |
| `SessionStarted`（その人の2つめ以降のセッション） | `userId` | なし（止められない） | `new_login`（`device`＝`deviceSummary`） | なし |

### 決めごと
- **`MeetupConfirmed`**：募集の予定（`broadcastId` がある）では通知しない。`BroadcastDecided` で通知するため（T-05）。
- **`actorId`**：`MeetupConfirmed` と `BroadcastDecided` の payload に足す。
  - `MeetupConfirmed`：「行く」「決める」を押した人。
  - `BroadcastDecided`：募集者。
  - それまでの行（`actorId` がない）は、参加者全員に送る。
- **`SessionStarted`**：その人のセッションのうち、このセッションより前に作られたものがあるときだけ「新端末のログイン」にする。最初のログインでは送らない。端末は区別しないので、同じ端末でのログインし直しにも送る。
- **相手（`actor`）**：表示するときに、公開プロフィール（`getPublicProfiles`）で読み直す。
  - お知らせの行には、相手のIDと対象のIDだけを持つ。名前・ひとこと・時刻は持たない。
  - 対象の中身は、押した先の画面（誘いの詳細など）で、閲覧者の権限で読む。
- **断り・見送り・キャンセル・抜けた**：静かな文言にする（赤を使わない）。
  - 断りの理由は出さない。
  - 自動の「今回は難しい」（T-06）と手の断りは、同じイベントなので同じお知らせになる。
  - 予定から抜けた人の名前は出さない（「予定から1人抜けました」）。
- **出さないもの**：期限切れ（T-04・T-05 のとおりイベントがない）、募集に応じたこと、友達の解除。

### 秘匿
通知の有無から、相手が「見せない」にしているか、募集に応じた人がいるかを推測させない。
- `BroadcastSent` は宛先全員に同じく届く。
- 応じたことは誰にも通知しない。
- 決まったことは参加者にだけ届く（参加者でない宛先には届かない。T-05 決定事項6）。
- 「見せない」の設定には、どのイベントも関係しない。

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/notification.ts`。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/notifications` | Bearer | query：`limit`（1〜50、既定20）、`cursor` | 200：`{ items: notificationSchema[], nextCursor }`（新しい順） | 400、401 |
| GET | `/api/v1/notifications/unread-count` | Bearer | なし | 200：`{ count }`（99で止める） | 401 |
| POST | `/api/v1/notifications/read-all` | Bearer | なし | 204（今あるお知らせをすべて既読にする） | 401 |
| GET | `/api/v1/me/notification-preferences` | Bearer | なし | 200：`notificationPreferencesSchema` | 401 |
| PUT | `/api/v1/me/notification-preferences` | Bearer | JSON：`notificationPreferencesSchema` | 200：同じ形 | 400、401 |
| GET | `/api/v1/push/vapid-key` | Bearer | なし | 200：`{ publicKey }`（base64url） | 401 |
| POST | `/api/v1/push/subscriptions` | Bearer | JSON：`{ endpoint }` | 204 | 400（許可していない宛先）、401、429（上限） |
| DELETE | `/api/v1/push/subscriptions` | Bearer | JSON：`{ endpoint }` | 204（なくても204） | 400、401 |

### 入力
- `notificationPreferencesSchema`：`{ invites, broadcasts, meetups, friends, calendar }`（すべて boolean、strict）。行がなければすべて `true`。
- `endpoint`：https の URL、2048字まで。
  - ホストは次のどれかに限る：`fcm.googleapis.com`、`updates.push.services.mozilla.com`、`web.push.apple.com`、`*.push.apple.com`、`*.notify.windows.com`。
  - サーバーがこの URL に POST するので、任意の宛先を受け付けない（SSRF 対策）。
  - 一覧は実装の最初に、各ブラウザの公式で確かめる。

### 出力
- `notificationSchema`：`{ id, kind, actor, subjectId, count, device, createdAt, readAt }`
  - `kind`：上の表の「お知らせの種類」。
  - `actor`：公開プロフィールか `null`。
  - `subjectId`：誘い・募集・予定・友達の ID か `null`。
  - `count`：`availability_cancelled` のときだけ数、ほかは `null`。
  - `device`：`new_login` のときだけ `deviceSummary`、ほかは `null`。
- 項目は種類にかかわらず同じにし、値がない項目は `null`。

### 例外
- **既読**：1件ずつにせず、`read-all` で一覧を開いたときにまとめて既読にする（未読の印を消すことだけが目的のため）。作成の `POST` ではないので `Idempotency-Key` は受け付けない（何度送っても同じ）。
- **プッシュの購読の解除**：本文を持つ `DELETE` にする。購読を表すのは endpoint だけで、URL のパスに入れたくないため（ログに残さない）。なくても204（ほかの人の購読があるかを推測させない）。
- **購読の登録**：作るリソースを1件で取得するAPIがないので、201 と `Location` を付けず、204 にする（T-03 と同じ考え方）。
- **購読の上限**：1人10件。超えたら429 `rate_limited`。時間で解けないので `Retry-After` は付けない（T-03 の409の扱いと同じく、例外として書く）。

## データ
マイグレーション `apps/api/migrations/0007_notification.sql`。日時はUnixミリ秒。

### `notifications`
- 列：`id`（UUID）、`user_id`（→ users、CASCADE）、`kind`、`actor_id`（null可）、`subject_id`（null可）、`count`（null可）、`device`（null可）、`event_id`（元の outbox の行の ID）、`created_at`、`read_at`（null可）、`delivered_at`（null可。送り終えた、または送らないと決めた日時）。
- 一意：`(event_id, user_id)`。同じイベントが2回届いても1件。
- インデックス：`(user_id, created_at, id)`（一覧）、`(user_id, read_at)`（未読数）。
- 保持：作成から90日（掃除は T-06 の Cron に足す）。

### `push_subscriptions`
- 列：`id`、`user_id`（→ users、CASCADE）、`endpoint_hash`（SHA-256。一意）、`endpoint_enc`（T-06 の `encryptSecret`。AAD は `push:<user_id>`）、`created_at`、`last_success_at`。
- 同じ endpoint を別の人が登録したら、前の人の行を消して付け替える（同じブラウザで別の人がログインした場合）。

### `notification_preferences`
- 列：`user_id`（PK、→ users、CASCADE）、`invites`、`broadcasts`、`meetups`、`friends`、`calendar`（0／1）、`updated_at`。

### `notification_daily_counts`
- 列：`user_id`、`day`（利用者のタイムゾーンでの `YYYY-MM-DD`）、`channel`（`push`・`email`）、`count`。PK は `(user_id, day, channel)`。
- 上限の判定は、`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ?` の1つの文で行う（同時に届いても超えない）。
- 2日より前の行は掃除する。

## 振る舞い

### お知らせを作って送る（consumer）
1. 受け取り手ごとに `notifications` に `INSERT OR IGNORE` する。
   - すでにあって `delivered_at` があれば何もしない（二重に届いた）。
   - `delivered_at` がなければ、続きから送る（前の試行が送る途中で落ちた）。
2. 種別が止められていれば、送らずに `delivered_at` を書く。`new_login` は止められない。
3. 送り先を決める（決定事項3）。
   - `new_login`：メールだけ。
   - ほかの種類：プッシュの購読が1つ以上あればプッシュ、なければメール。
   - メールアドレス（`users.email`）がない人にはメールを送らない。
4. 1日の上限を確かめる（決定事項4）。
   - プッシュは1日30件、メールは1日10件。`new_login` は上限に数えない。
   - 超えたら送らずに `delivered_at` を書く。お知らせ一覧には残る。
5. 送る。
   - **プッシュ**：購読ごとに、endpoint へ本文なしで `POST` する。
     - ヘッダー：`TTL: 86400`、`Urgency: normal`、`Authorization: vapid t=<JWT>, k=<公開鍵>`。
     - JWT は ES256。`aud` は endpoint のオリジン、`exp` は12時間以内、`sub` は `VAPID_SUBJECT`。jose で作る。
     - 201・202 は成功で、`last_success_at` を書く。
     - 404・410 は購読を消す（失敗にしない）。
     - 429・5xx・タイムアウトは一時的な失敗として投げる。
   - **メール**：Resend に送る（下の「メールの中身」）。
6. 送り終えたら `delivered_at` を書く。
   - 一時的な失敗は Queue の再試行（最大5回、間隔を広げる）に任せる。
   - 最後まで失敗したら退避キューへ送る（T-06 と同じ）。
   - 購読が複数あって途中で失敗すると、再試行で同じ端末に2回届くことがある。中身がないので受け入れる。

### プッシュの購読と Service Worker
- フロントの手順：
  1. 設定画面で「プッシュ通知を受け取る」を押す。
  2. ブラウザの通知の許可を取る。
  3. `GET /push/vapid-key` で公開鍵を取り、`pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` で購読する。
  4. `POST /push/subscriptions` に endpoint だけを送る。
- Service Worker（`apps/web/public/sw.js`）
  - `push` のたびに、`showNotification("ここ暇", { body: "新しいお知らせがあります", tag: "kokohima", renotify: false })` を出す。同じ `tag` で1つにまとめる。
  - `notificationclick` でお知らせ一覧（`/notifications`）を開く。
  - API は呼ばない（アクセストークンはメモリだけにあり、Service Worker には渡さない）。
  - キャッシュはしない（このタスクではオフライン対応をしない）。
- iOS では、ホーム画面に追加した PWA でだけ Webプッシュを受け取れる。
  - そのため、`manifest.webmanifest`（名前・アイコン・`display: standalone`）を足す。
  - 追加していない人には、設定画面で「ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます」と出す。
- ログアウトでは購読を消さない（同じブラウザで次にログインした人に付け替える）。
- 全端末ログアウトでは、その人の購読をすべて消す。

### メールの中身
- 差出人は vars の `MAIL_FROM`（例：`ここ暇 <notify@example.invalid>`）。宛先は `users.email`。
- 本文はテキストだけ。HTML は送らない。
- 相手の名前・ひとこと・エリア・時刻を入れない（決定事項6）。
- **お知らせのメール**
  - 件名：「ここ暇：新しいお知らせがあります」。
  - 本文：お知らせの種類の短い説明（例：「誘いが届きました」「予定が成立しました」「予定がなくなりました」）と、アプリのトップ（`APP_ORIGIN`）を開くよう促す1文。
  - ログイン用のリンク（トークンつきの URL）は入れない。
- **新端末のログインのメール**
  - 件名：「ここ暇：新しい端末でログインがありました」。
  - 本文：端末の要約（`deviceSummary`）と日時（利用者のタイムゾーン）。心当たりがなければ、アプリの「すべての端末からログアウト」を押すよう書く。
- 停止の方法：本文の最後に「通知はアプリの設定で止められます」と書く。新端末のログインのメールは止められないことも書く。
- Apple の中継メール（`privaterelay.appleid.com`）に届けるには、送信ドメインを Apple に登録する（人が行う。T-01 の残り）。

### お知らせ一覧（画面）
- `/notifications`。ナビに「お知らせ」を足し、未読があれば数を出す（赤を使わない）。
- 一覧を開いたら `read-all` を呼ぶ。
- 1件ずつ種類に合った文言を出し、押すと対象の画面へ移る。
  - 誘い：`/invites/{id}`。募集：`/broadcasts/{id}`。予定：`/meetups/{id}`。友達：`/friends/{id}`。
  - 自動取り消し：ここ暇タブ。連携の失効：`/settings/calendar`。新端末のログイン：友達タブの「アカウント」。
- 文言（仮）
  - 「〇〇さんから誘いが届きました」「〇〇さんは今回は難しいみたい」「〇〇さんから別の時間の提案があります」「今回は見送りになりました」
  - 「〇〇さんが募集しています」「〇〇さんの募集が決まりました」「〇〇さんと予定が成立しました」
  - 「予定がなくなりました」「予定から1人抜けました」
  - 「〇〇さんと友達になりました」
  - 「カレンダーの予定と重なったここ暇を〇件取り消しました」「カレンダーの連携が切れました」
  - 「新しい端末でログインがありました（〇〇）」
  - 名前は公開プロフィールの表示名。表示名がなければ「名前未設定の友達」。
- **友達追加のお知らせ**：「この人に見せない」のボタンを置く（F-08）。押すと `PATCH /friends/{friendId}`（T-02）で見せないにし、「見せないにしました」を静かに出す。友達でなくなっていれば（404）、ボタンを消す。
- **設定（`/settings/notifications`）**
  - 友達タブの「アカウント」節からリンクする。
  - 種別ごとのスイッチ5つ。
  - プッシュ通知の受け取り（この端末で購読する・やめる）。
  - 「新しい端末でのログインのお知らせは止められません」と書く。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `RESEND_API_KEY` | secret | Resend の API キー |
| `VAPID_PRIVATE_KEY` | secret | VAPID の秘密鍵（P-256、PKCS#8） |
| `VAPID_PUBLIC_KEY` | vars | VAPID の公開鍵（base64url、非圧縮の点） |
| `VAPID_SUBJECT` | vars | `mailto:` の連絡先 |
| `MAIL_FROM` | vars | 差出人 |

- ローカルと E2E の鍵は `scripts/write-e2e-dev-vars.mjs` で作る（T-06 と同じ）。
- 送信ドメインの SPF・DKIM・DMARC は、Resend の手順で DNS に設定する（人が行う。`infra-change` スキルに従い、Terraform で管理するなら別の PR にする）。

### E2E用の偽のメール・プッシュ
- E2E のエントリで、Resend とプッシュの宛先への `fetch` を偽の実装に向ける（T-06 の `e2eFetch` に足す）。
- 送った中身は、E2E のエントリだけが作る表に残す。
- `/__e2e__/notifications/sent` で、閲覧者に送ったメール・プッシュを読めるようにする（`E2E_MODE=1` のときだけ）。
- 購読の登録は、テストから `POST /push/subscriptions` に偽の endpoint（E2E のときだけ許可するホスト）を送って行う。ブラウザの許可の画面は使わない。
- CI の本番ビルドの検査に、新しい名前を足す。

## 認可と秘匿

### 閲覧者IDの使い方
- すべてのAPIで、閲覧者は `requireAuth` から取る。
- お知らせ・設定・購読は、`user_id = 閲覧者` の条件でだけ読み書きする。

### 他人のデータに届かないことの保証
- 他人のお知らせは、一覧・未読数・既読のどれにも出ない。
- 他人の購読は消せない。同じ endpoint の付け替えは、登録した本人の行になる。
- consumer の書き込み先は、payload の ID と invitation の関数で決めた受け取り手だけ。

### 区別させない応答
- 「お知らせの作り方」の「秘匿」のとおり。
- 購読の解除は、なくても204。
- 設定で止めた種別も、お知らせ一覧の形は同じ。

### 外部に渡すもの
- プッシュのサービスに渡すのは、本文のないリクエストと VAPID の署名だけ。
- メールの配信サービスに渡すのは、宛先のメールアドレス・件名・中身のない本文だけ。
- ログには、お知らせの種類・送り先の種類（push・email）・結果だけを出す。メールアドレス・endpoint・API キーは出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] お知らせの作り方：表のイベントごとに、受け取り手・種類・相手が正しい。
  - `actorId` には送らない。
  - 募集の `MeetupConfirmed` では送らない。
  - `actorId` のない古い行は参加者全員に送る。
- [ ] `SessionStarted`：最初のセッションでは送らず、2つめ以降はメールで送る。止める設定と上限に関係しない。
- [ ] 同じイベントが2回届いても1件。送る途中で落ちた行は、再試行で送り終える。
- [ ] 止めた種別はプッシュもメールも送らず、一覧には残る。
- [ ] 送り先：購読があればプッシュだけ、なければメールだけ。メールアドレスがなければ送らない。
- [ ] 1日の上限：プッシュ30件・メール10件で止まる。同時に届いても超えない。日付が変われば戻る。
- [ ] プッシュ
  - 本文がない。ヘッダー（`TTL`・`Authorization: vapid`）と JWT（`aud`・`exp`・`sub`、ES256）が正しい。
  - 404・410 で購読を消す。5xx・429・タイムアウトで投げる。
- [ ] メール
  - `Idempotency-Key` がお知らせの ID。本文に相手の名前・ひとこと・ログイン用のリンクが入らない。
  - 429・5xx で投げる。
- [ ] 古い outbox の行（7日より前）は送らずに処理済みにする。
- [ ] API
  - 一覧の並び・カーソル・未読数・`read-all`。他人のお知らせが出ない。
  - 設定の取得・更新（行がないときは全部 `true`）、strict でない本文は400。
- [ ] 購読
  - 許可したホストだけ受け付ける（http・ほかのホスト・IP アドレス・長すぎる URL は400）。上限10件。
  - 解除はなくても204。同じ endpoint を別の人が登録すると付け替える。
  - 他人の購読を消せない。全端末ログアウトで消える。
- [ ] ログに、メールアドレス・endpoint・API キー・相手の名前が出ない。
- [ ] Web
  - お知らせ一覧の文言（断り・キャンセルが静かな表示）。未読の数、開いたら既読。
  - 友達追加のお知らせの「この人に見せない」。設定のスイッチ。

### E2Eテスト（対象にする利用者の流れ）
- [ ] A が B を誘う → B のナビに未読が出て、お知らせ一覧に「A さんから誘いが届きました」が出る → 押すと誘いの詳細が開く。B はプッシュの購読がないので、偽のメールが1通届いている。
- [ ] A のリンクで B が友達になる → A のお知らせ一覧の「この人に見せない」を押す → B の「みんな」に A のここ暇が出ない。
- [ ] B が設定で「誘い」を止める → A が誘う → お知らせ一覧には出るが、偽のメールは届かない。

## スコープ外
- 通知の文言とデザインの最終版（デザインのタスク）。
- 週次通知（Phase 2）、ネイティブアプリのプッシュ、メールの開封・クリックの計測。
- オフライン対応（Service Worker のキャッシュ）。
- 送信ドメインの DNS の設定そのもの（人が行う）。
- 退会（別タスク。退会でお知らせ・購読・設定は CASCADE で消える）。
- 通知の時間帯の指定（夜は送らない、など）。

## 決定事項（仕様書PRのレビューで合意）
1〜4 は、仕様書を書く前に利用者に確かめた。5〜7 は提案で、PRのレビューで合意する。

1. メールの配信は Resend を使う。
2. Webプッシュには中身を載せず、アプリのお知らせ一覧で読む。プッシュのサービスに相手の名前や誘いの内容を渡さない。
3. メールは、プッシュの購読がない人だけに送る。新端末のログインだけは全員にメールで送る。
4. 種別ごと（誘い・募集・予定・友達・カレンダー）に止められる。1日の上限はプッシュ30件・メール10件で、超えた分はお知らせ一覧だけに残す。新端末のログインは止められず、上限にも数えない。
5. （提案）T-06 より前から残っている通知の型の outbox の行は、作成から7日を過ぎていたら送らない。
6. （提案）メールの本文にも、相手の名前・ひとこと・エリア・時刻を入れない（プッシュと同じく「新しいお知らせがあります」と種類の説明だけ）。
7. （提案）新端末のログインは、端末を区別せず「その人の2つめ以降のセッション」で判定する。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-14 | 初版 | |
