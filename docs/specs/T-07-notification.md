# T-07 仕様書：通知（Webプッシュとメール）

- 状態：合意済み
- タスク票：docs/tasks/T-07-notification.md
- 関係する要件：F-06、F-08、F-16、NF-02、NF-07、要求定義書の未決事項「通知の種別と頻度、メールにする通知、停止設定、自動取り消しのまとめ通知」、セキュリティ設計（新端末のログインのメール通知、通知メールにログイン用のリンクを入れない、SPF・DKIM・DMARC）

## 概要
各コンテキストが outbox に書いたイベントから、受け取り手ごとの「お知らせ」を作る。通知の中身はアプリのお知らせ一覧でだけ読む。
- Webプッシュは、中身のないプッシュ（VAPID の署名だけ）で「新しいお知らせがあります」と知らせる。押すとお知らせ一覧が開く（決定事項2）。相手の名前や誘いの内容は、プッシュのサービス（Apple・Google・Mozilla・Microsoft）に渡さない。
- メールは、プッシュで届けられない人に送る。本文は、お知らせの種類の短い説明だけ（決定事項3・6）。新端末のログインだけは、全員にメールで送る。
- 種別ごとに止められる。1日の上限を超えた分は送らない（決定事項4）。どちらもお知らせ一覧には残る。

## 前提

### コンテキストの分担
- コンテキストは `notification`（`apps/api/src/notification/{domain,application,infra}`）。
- 送るのは T-06 の outbox → Queue → consumer の流れ（`apps/api/src/jobs/`）。
  - `jobs/dispatch.ts` の `DISPATCHED_TYPES` に通知の型を足す。
  - `jobs/consumer.ts` は、イベントからお知らせを作り、受け取り手ごとに届けるメッセージを Queue に分ける（「お知らせを作って送る」）。
  - T-06 の型（`MeetupConfirmed`・`MeetupCancelled`・`MeetupLeft`）は、カレンダーの書き込みと通知の両方を呼ぶ。
    - 通知を先に呼ぶ。
    - 片方が失敗しても、もう片方は試す。どちらかが失敗していれば、最後に投げる。
    - どちらも冪等なので、再試行で両方をもう一度呼んでよい。
- ほかのコンテキストの表は読まない。それぞれの application の関数を通す。
  - identity：
    - `getPublicProfiles`（相手の表示名）
    - `getUserTimezone`（日付と時刻）
    - 新しく足す `getNotificationAddress(userId)`（メールアドレス。なければ null）
    - 新しく足す `hasEarlierSession(userId, sessionId)`（このセッションより前に作られたセッションがあるか）
  - invitation：新しく足す次の関数（`calendarFacing.ts` と同じく、閲覧者で絞らない consumer 用の関数）。
    - `broadcastOwnerOf(broadcastId)`
    - `inviteActorOf(inviteId)`：予定を成立させた操作をした人。`decided_at` があれば送信者、なければ受信者。
    - `meetupParticipantsOf(meetupId)`
  - availability：`setSharing`。画面からは T-02 の `PATCH /friends/{friendId}` を使う。
  - identity から notification を呼ぶ：
    - ログアウトで、そのセッションの購読を消す（`deleteSubscriptionsOfSession`）。
    - 全端末ログアウトで、その人の購読をすべて消す（`deleteSubscriptionsOf`）。

### 外部とのつなぎ方
- 外部呼び出しは `AppDeps.fetch` を通す。Resend とプッシュの宛先は、テストと E2E で差し替える。タイムアウトは5秒。
- メールの配信は Resend（決定事項1）。
  - `POST https://api.resend.com/emails`、`Authorization: Bearer <RESEND_API_KEY>`。
  - `Idempotency-Key` にお知らせの ID を入れる。
  - 再試行で二重に送らない。
  - レート制限の既定値（検索の結果では1チームで1秒あたり2件とも10件ともある）、冪等キーの応答（同時の再送・内容の不一致）、エラーの形は、実装の最初に公式で確かめる。
  - 値に合わせて、consumer の同時実行数（wrangler の `max_concurrency`）を絞る。
- Webプッシュは RFC 8030 と RFC 8292（VAPID）。
  - 中身を送らないので、RFC 8291 の暗号化は実装しない。購読の `p256dh`・`auth` の鍵も受け取らず、保存しない。
  - 各ブラウザのプッシュのサービスの次の点を、実装の最初に公式で確かめる。
    - VAPID の `exp` の上限と `sub` の制約（`localhost` を拒むなど）
    - 本文なしの送信を受け付けるか
    - endpoint のホスト
- 1回の consumer の呼び出しでの外部 fetch と D1 の呼び出しの数は、Workers の上限（サブリクエストの数）に収める。上限の値は実装の最初に公式で確かめる。受け取り手ごとにメッセージを分けるのはこのため。

### 古い outbox の行
- T-07 を有効にした時刻より前に作られた行は、送らない（決定事項5）。本番の運用前の行（もう返事が済んだ誘い、ログインし直しの `SessionStarted` など）が、一度にまとめて届かないようにするため。
- 対象は、T-07 で新しく取り出す通知だけの型の行。
  - 型：`SessionStarted`・`FriendshipEstablished`・`DirectInvite*`・`BroadcastSent`・`BroadcastDecided`・`AvailabilityCancelledByCalendar`・`CalendarReauthRequired`。
  - 線は経過日数でなく、「T-07 を有効にした時刻」で引く。この時刻は、マイグレーション（`0007_notification.sql`）で1行の設定の表 `notification_settings`（`started_at`）に、適用した時刻を書く。
  - `created_at < started_at` の行を、dispatch で Queue に流さずに処理済みにする。
  - デプロイの後に outbox の処理が長く止まっても、T-07 を有効にした後の行は捨てない（遅れて届く）。
- T-06 の型の行は、今までどおり流す。

### 実装PRで直すもの
- 要求定義書
  - ドメインイベントの表
  - 未決事項「通知の種別と頻度…」を閉じる
  - 技術選定の「メール配信（サービスは要選定）」を Resend にする
- invitation-domain スキル
  - イベントの表（「通知（T-07）」の書き方）
  - 用語表に「お知らせ」を足す
- docs/design/README.md の「通知一覧」「通知設定」と、この仕様書の「お知らせ」の呼び方をそろえる。画面の文言は「お知らせ」。

## 用語
| 画面 | コード | 備考 |
| --- | --- | --- |
| お知らせ | Notification | 受け取り手1人ぶんの1件。一覧で読む |
| 通知の設定 | NotificationPreferences | 種別ごとのオン／オフ |
| プッシュの購読 | PushSubscription | 端末（ブラウザ）とセッションごとに1つ |

## お知らせの作り方

### 種別と受け取り手
受け取り手と相手は、payload の ID と invitation の関数から決める。

| イベント | 受け取り手 | 種別（設定の単位） | お知らせの種類 | 相手（`actor`） |
| --- | --- | --- | --- | --- |
| `DirectInviteSent` | `userId`（受信者） | `invites` | `invite_received` | `actorId`（送信者） |
| `DirectInviteDeclined` | `userId`（送信者） | `invites` | `invite_declined` | `actorId`（受信者） |
| `DirectInviteCounterProposed` | `userId`（送信者） | `invites` | `invite_countered` | `actorId`（受信者） |
| `DirectInviteSkipped` | `userId`（受信者） | `invites` | `invite_skipped` | `actorId`（送信者） |
| `BroadcastSent` | `userId`（宛先ごと） | `broadcasts` | `broadcast_received` | `actorId`（募集者） |
| `BroadcastDecided` | `participantIds` から募集者を除いた人 | `broadcasts` | `broadcast_decided` | 募集者 |
| `MeetupConfirmed`（`inviteId` が null でないときだけ） | `participantIds` から成立させた人を除いた人 | `meetups` | `meetup_confirmed` | 成立させた人 |
| `MeetupCancelled` | `participantIds` から `actorId` を除いた人 | `meetups` | `meetup_cancelled` | なし |
| `MeetupLeft` | `participantIds`（残った人） | `meetups` | `meetup_left` | なし |
| `FriendshipEstablished` | `userId`（友達になった2人のそれぞれに1件ずつ） | `friends` | `friend_added` | `friendId` |
| `AvailabilityCancelledByCalendar` | `userId` | `calendar` | `availability_cancelled`（`count` は `ranges` の数） | なし |
| `CalendarReauthRequired` | `userId` | `calendar` | `calendar_reauth` | なし |
| `SessionStarted`（`hasEarlierSession` が真のとき） | `userId` | なし（止められない） | `new_login`（`device` は `deviceSummary`） | なし |

### 受け取り手の決め方
- `actorId` を持つイベントでは、`actorId` の人（手を下した本人）には送らない。
- `BroadcastDecided` の募集者は `broadcastOwnerOf`、`MeetupConfirmed` の成立させた人は `inviteActorOf` で決める。payload は変えない。
- `MeetupConfirmed` は、募集の予定（`inviteId` が null）では送らない。`BroadcastDecided` で知らせるため（T-05）。判定はキーがあるかでなく、値が null かで行う。
- `MeetupCancelled` の `participantIds` は、取り消しの前に抜けていなかった人（T-05）。先に抜けていた人には届かない。
- `FriendshipEstablished` は2件書かれる（T-02）。リンクを出した人と開いた人の両方に1件ずつ届く。取り違えて友達になった本人が、お知らせから「見せない」にできるようにするため（T-02 の受容したリスク）。
- `SessionStarted` は、その人のセッションのうち、このセッションより前に作られたものがあるときだけ送る。
  - 失効・期限切れのセッションも数える。今はセッションの行を消す処理がないので、最初のログインかどうかがこれでわかる。
  - 端末は区別しない（決定事項7）。同じ端末でのログインし直しにも送る。

### お知らせの行に持つもの
- 相手の ID と対象の ID、数（自動取り消し）、端末の要約（新端末のログイン）だけを持つ。名前・ひとこと・時刻は持たない。
- 相手は、表示するときに公開プロフィール（`getPublicProfiles`）で読み直す。
- 対象の中身は、押した先の画面（誘いの詳細など）で、閲覧者の権限で読む。
- お知らせの `createdAt`（表示する日時）は payload の `occurredAt`。新端末のログインのメールの日時もこれ。
- 一覧の並びと既読の `upTo` の比較には、行を作った時刻（`inserted_at`）を使う。outbox → Queue を通って遅れて届いたお知らせが、一覧の下に入ったり、見られないまま既読になったりしないようにするため。

### 静かに出すもの・出さないもの
- 断り・見送り・キャンセル・抜けたは、静かな文言にする（赤を使わない）。
  - 断りの理由は出さない。
  - 自動の「今回は難しい」（T-06）と手の断りは同じイベントなので、同じお知らせになる。
  - 予定から抜けた人の名前は出さない（「予定から1人抜けました」）。
- 次のものはお知らせにしない。
  - 期限切れ（T-04・T-05 のとおりイベントがない）
  - 募集に応じたこと・応じるのをやめたこと
  - 友達の解除
  - 「見せない」の切り替え

### 秘匿
通知の有無から、相手が「見せない」にしているか、募集に応じた人がいるかを推測させない。
- `BroadcastSent` は宛先全員に同じく届く。
- 応じたことは誰にも知らせない。
- 決まったことは参加者にだけ届く。参加者でない宛先には届かない（T-05 決定事項6）。
- 「見せない」の設定は、どのイベントにも関係しない。
- 受け入れるリスク：自動の「今回は難しい」はカレンダーの確認の時刻にまとまって届くので、お知らせの時刻から自動だと推し量られる余地がある（T-06 で受け入れたものと同じ）。

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/notification.ts`。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/notifications` | Bearer | query：`limit`（1〜50、既定20）、`cursor` | 200：`{ items: notificationSchema[], nextCursor }`（新しい順） | 400、401 |
| GET | `/api/v1/notifications/unread-count` | Bearer | なし | 200：`{ count }`（99で止める） | 401 |
| POST | `/api/v1/notifications/read` | Bearer | JSON：`{ upTo }`（一覧で見たいちばん新しいお知らせの `id`） | 204（その行以前に作られたお知らせを既読にする） | 400、401 |
| GET | `/api/v1/me/notification-preferences` | Bearer | なし | 200：`notificationPreferencesSchema` | 401 |
| PATCH | `/api/v1/me/notification-preferences` | Bearer | JSON：`notificationPreferencesPatchSchema` | 200：`notificationPreferencesSchema` | 400、401 |
| GET | `/api/v1/push/vapid-key` | Bearer | なし | 200：`{ publicKey }`（base64url） | 401 |
| POST | `/api/v1/push/subscriptions` | Bearer | JSON：`{ endpoint }` | 204 | 400（許可していない宛先）、401 |
| DELETE | `/api/v1/push/subscriptions` | Bearer | JSON：`{ endpoint }` | 204（なくても204） | 400、401 |

### 入力
- `notificationPreferencesSchema`：`{ invites, broadcasts, meetups, friends, calendar }`（すべて boolean、strict）。行がなければすべて `true`。
- `notificationPreferencesPatchSchema`：同じ項目のうち、1つ以上（strict）。
- `upTo`：閲覧者のお知らせの `id`。閲覧者のものでなければ400。`(inserted_at, id)` がその行以下のお知らせを既読にする。
- `endpoint`
  - 2048字まで。URL として解析してから、次をすべて満たすときだけ受け付ける（SSRF 対策。サーバーがこの URL に POST するため）。
    - スキームが `https`。
    - ポートの指定がない。
    - `user:pass@` の形（userinfo）がない。
    - ホストが IP アドレスでない。
    - ホスト名（小文字にしたもの）が次のどれかに一致する：`fcm.googleapis.com`、`updates.push.services.mozilla.com`、`web.push.apple.com`、`.push.apple.com` で終わるもの、`.notify.windows.com` で終わるもの。
      - 末尾一致は「`.` ＋サフィックス」で比べる。
      - 一覧は実装の最初に、各ブラウザの公式で確かめる。
  - E2E 用の偽のホストは、`createWorker` に渡す値で足す。env の値では足せないので、本番のビルドで有効にできない。

### 出力
- `notificationSchema`：`{ id, kind, actor, subjectId, count, device, createdAt, readAt }`
  - `kind`：上の表の「お知らせの種類」。
  - `actor`：公開プロフィールか `null`。
  - `subjectId`：誘い・募集・予定・友達の ID か `null`。
  - `count`：`availability_cancelled` のときだけ数、ほかは `null`。
  - `device`：`new_login` のときだけ `deviceSummary`、ほかは `null`。
- 項目は種類にかかわらず同じにし、値がない項目は `null`。

### 例外
- 既読
  - 1件ずつではなく、一覧を開いたときに `POST /notifications/read` でまとめて既読にする（未読の印を消すことだけが目的のため）。
  - `upTo` を受け取り、一覧を読んでから既読にするまでの間に届いたお知らせは既読にしない。
  - 何度送っても同じなので、`Idempotency-Key` は受け付けない。
- プッシュの購読の解除
  - 本文を持つ `DELETE` にする。購読を表すのは endpoint だけで、URL のパスに入れたくない（ログに残さない）ため。
  - なくても204（ほかの人の購読があるかを推測させない）。
- 購読の登録
  - 作るリソースを1件で取得するAPIがないので、201 と `Location` を付けず、204 にする（T-03 と同じ考え方）。
  - 何度送っても同じなので、`Idempotency-Key` は受け付けない。

## データ
マイグレーション `apps/api/migrations/0007_notification.sql`。日時はUnixミリ秒。

### `notifications`
- 列
  - `id`（UUID）、`user_id`（→ users、CASCADE）、`kind`
  - `actor_id`・`subject_id`・`count`・`device`（どれも null可）
  - `event_id`（元の outbox の行の ID）、`created_at`（`occurredAt`。表示する日時）、`inserted_at`（行を作った時刻。並びと既読に使う）、`read_at`（null可）
  - `channel`（`push`・`email`・`none`。送り先を決めたら書く）
  - `counted_push_at`・`counted_email_at`（それぞれのチャネルの1日の数に入れた日時）
  - `delivered_at`（送り終えた、または送らないと決めた日時）
  - `outcome`（`sent`・`muted`・`limited`・`no_address`・`failed`）
- 一意：`(event_id, user_id)`。同じイベントが2回届いても1件。
- インデックス：`(user_id, inserted_at, id)`（一覧）、`(user_id, read_at)`（未読数）、`(inserted_at)`（掃除）。
- 保持：作成から90日。掃除は T-06 の Cron に足す。

### `push_subscriptions`
- 列
  - `id`、`user_id`（→ users、CASCADE）、`session_id`（→ sessions、CASCADE）
  - `endpoint_hash`（SHA-256。一意）
  - `endpoint_enc`（T-06 の `encryptSecret`。鍵は `NOTIFICATION_KEYS`・`NOTIFICATION_CURRENT_KID`、AAD は `push:<user_id>`）
  - `created_at`、`last_success_at`
- 登録すると、その時点の閲覧者とセッションに結びつける。
  - 同じ endpoint がすでにあれば、別の人の行でも付け替える（同じブラウザで別の人がログインした場合）。
  - 受け入れるリスク：endpoint を知っている人は、他人の購読を自分に付け替えられる。付け替えられた人はメールに切り替わり、その端末に付け替えた人の合図が届く。endpoint はほぼ推測できない URL で、プッシュに中身がないので受け入れる。
  - 自分がすでに登録している endpoint の登録し直しは、数に入れない。
- 1人10件まで。超えたら、いちばん古い購読を消して入れ替える。
- ログアウトでは、そのセッションの購読を消す。全端末ログアウトでは、その人の購読をすべて消す。
- 更新用トークンの再利用の検知でセッションの系列を失効させるときも、そのセッションの購読を消す（T-01 の更新の処理に足す。identity から notification の `deleteSubscriptionsOfSession` を呼ぶ）。
- 届けるときは、購読の `session_id` のセッションが失効しておらず期限内のもの（`requireActiveSession` と同じ条件）だけを使う。使えない購読は、そのとき消す。盗まれて失効させたセッションや、90日で切れたセッションの端末に、合図を送り続けないため。

### `notification_preferences`
- 列：`user_id`（PK、→ users、CASCADE）、`invites`、`broadcasts`、`meetups`、`friends`、`calendar`（0／1）、`updated_at`。

### `notification_settings`
- 1行だけの設定の表。`started_at`（T-07 を有効にした時刻）。マイグレーションで、適用した時刻（`unixepoch('subsec') * 1000`）を書く。
- 古い outbox の行の線引き（「古い outbox の行」）に使う。

### `notification_daily_counts`
- 列：`user_id`、`day`（利用者のタイムゾーンでの `YYYY-MM-DD`）、`channel`（`push`・`email`）、`count`。PK は `(user_id, day, channel)`。
- 数を増やすのは、そのチャネルの `counted_push_at`・`counted_email_at` が NULL のときだけ。
  - 増やす文と、お知らせにそのチャネルの日時を書く文を、同じ batch にする（日時を確かめる `EXISTS` 付き。T-04 の `transition_id` と同じ書き方）。
  - 再試行でも同じお知らせを、同じチャネルで2回数えない。
  - プッシュからメールに切り替えたときは、メールの分を「メールで数えていなければ数える」。プッシュで数えた分は戻さない（プッシュの上限を少し早く使い切ることを受け入れる）。
- 上限の判定は、`INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < ?` の1つの文で行う（同時に届いても超えない）。
- 2日より前の行は掃除する。

## 振る舞い

### お知らせを作る（イベントのメッセージ）
1. 受け取り手を決める（「お知らせの作り方」）。
2. 受け取り手ごとにお知らせを作る：`INSERT OR IGNORE INTO notifications ... SELECT ... WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`。退会した人には書かず、投げ続けない。
3. 作った（またはすでにあって `delivered_at` が NULL の）お知らせごとに、`{ kind: "notification_deliver", notificationId }` を Queue に `sendBatch` する（100件ずつ）。
   - 届ける処理を受け取り手ごとに分ける。1つのメッセージでの外部呼び出しの数を抑え、1人への失敗がほかの人の再試行を使わないようにするため。
   - 受け取り手は、募集で最大101人。

### 届ける（`notification_deliver` のメッセージ）
1. お知らせを読む。`delivered_at` があれば何もしない（二重に届いた）。
2. 種別が止められていれば、送らずに `delivered_at` と `outcome = 'muted'` を書く。`new_login` は止められない。
3. 送り先（`channel`）を決める（決定事項3）。
   - `new_login`：メールだけ。
   - ほかの種類：プッシュの購読が1つ以上あればプッシュ、なければメール。
   - メールアドレスがない人には、メールを送らない（`outcome = 'no_address'`）。
4. 1日の上限を確かめる（決定事項4）。
   - プッシュは1日30件、メールは1日10件。`new_login` は上限に数えない。
   - 超えたら送らずに `delivered_at` と `outcome = 'limited'` を書く。お知らせ一覧には残る。
5. 送る。
   - プッシュ
     - 使える購読（セッションが有効なもの）だけを使う。使えない購読は消す。
     - 購読ごとに、復号した endpoint をもう一度、入力と同じ規則で確かめてから、本文なしで `POST` する。
     - オプション：`redirect: "manual"`（3xx は失敗）。
     - ヘッダー：`Content-Length: 0`、`TTL: 86400`、`Urgency: normal`、`Authorization: vapid t=<JWT>, k=<公開鍵>`。
     - JWT は ES256。`aud` は endpoint のオリジン、`exp` は12時間以内、`sub` は `VAPID_SUBJECT`。jose で作る。
     - 応答の扱い
       - 201・202：成功。`last_success_at` を書く。
       - 404・410：購読を消す。
       - 429・5xx・タイムアウト：一時的な失敗。
       - 400・401・403・413：その購読だけ一時的でない失敗とし、ログに種類と状態コードを出す。
   - 送れる購読が1つもなかったとき（すべて消えた・セッションが無効・一時的でない失敗）：同じお知らせをメールに切り替えて送る。メールの上限で数える（`channel` を `email` に書き直す。数え方は `notification_daily_counts`）。
   - メール：Resend に送る（下の「メールの中身」）。
     - 429・5xx・タイムアウト・冪等キーの同時の再送：一時的な失敗。
     - 400・401・403・422（Apple の中継アドレスでドメインが未登録など）：一時的でない失敗。
6. 終わり方
   - 送り終えたら、`delivered_at` と `outcome = 'sent'` を書く。
   - 一時的でない失敗は、`delivered_at` と `outcome = 'failed'` を書き、ログに種類と状態コードだけを出す。
   - 一時的な失敗は投げる。Queue の再試行（最大5回、間隔を広げる）に任せ、最後まで失敗したら退避キューへ送る（T-06 と同じ）。
- 受け入れること
  - 購読が複数あって途中で失敗すると、再試行で同じ端末に2回届くことがある。
  - dispatch の途中で落ちて同じメッセージが同時に2回処理されても、同じことが起きる。
  - 中身がなく、同じ `tag` で1つにまとまるので受け入れる。メールは冪等キーで防ぐ。

### プッシュの購読と Service Worker
- フロント
  - 設定画面で「この端末でプッシュ通知を受け取る」を押す。
  - ブラウザの通知の許可を取る。
  - `GET /push/vapid-key` で公開鍵を取り、`pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` で購読する。
  - `POST /push/subscriptions` に endpoint だけを送る。
- アプリを開くたび（ログイン中で、通知が許可済みのとき）、`pushManager.getSubscription()` の endpoint を `POST /push/subscriptions` に送り直す（冪等）。
  - ブラウザが購読を切り替えたときも、別の人がログインしたときも、ここで追いつく。
  - Service Worker は API を呼ばないので、`pushsubscriptionchange` では何もしない。
- ログアウトするとき、フロントは `getSubscription()` の endpoint で `DELETE /push/subscriptions` を呼んでからログアウトする。呼べなくても、サーバーがセッションの購読を消す。
- Service Worker（`apps/web/public/sw.js`）
  - `push` で `event.waitUntil(self.registration.showNotification("ここ暇", { body: "新しいお知らせがあります", tag: "kokohima" }))` を出す。同じ `tag` で1つにまとめる。
  - `notificationclick` で、お知らせ一覧（`/notifications`）を開く。
  - API を呼ばない（アクセストークンはメモリだけにあり、Service Worker には渡さない）。
  - キャッシュをしない（このタスクではオフライン対応をしない）。
- iOS
  - ホーム画面に追加した PWA でだけ、Webプッシュを受け取れる。そのため `manifest.webmanifest`（名前・アイコン・`display: standalone`）を足す。
  - 追加していない人には、設定画面で「ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます」と出す。

### メールの中身
- 差出人は vars の `MAIL_FROM`（例：`ここ暇 <notify@example.invalid>`）。宛先は `getNotificationAddress`。
- テキストだけで、HTML は送らない。
- 相手の名前・ひとこと・エリア・予定の時刻を入れない（決定事項6）。
- ログイン用のリンク（トークンつきの URL）を入れない。アプリのトップ（`APP_ORIGIN`）の URL だけを書く。
- お知らせのメール
  - 件名：「ここ暇：新しいお知らせがあります」
  - 本文：お知らせの種類の短い説明（例：「誘いが届きました」「予定が成立しました」「予定がなくなりました」）と、アプリを開くよう促す1文。
- 新端末のログインのメール
  - 件名：「ここ暇：新しい端末でログインがありました」
  - 本文：端末の要約（`deviceSummary`）とログインの日時（`occurredAt` を利用者のタイムゾーンで）。心当たりがなければ、アプリの「すべての端末からログアウト」を押すよう書く。
- 本文の最後に、「通知はアプリの設定で止められます（新しい端末でのログインのお知らせは止められません）」と書く。
- Apple の中継メール（`privaterelay.appleid.com`）に届けるには、送信ドメインを Apple に登録する（人が行う。T-01 の残り）。
  - 未登録のあいだは 422 などで失敗する。一時的でない失敗として、お知らせ一覧にだけ残る。

### お知らせ一覧（画面。仮）
- 画面は `/notifications`。最終的なデザインでは、一覧をシートにすることがある。
- ナビに「お知らせ」を足し、未読があれば数を出す（赤を使わない）。
- 一覧を開いたら、見えているいちばん新しい `id` で `POST /notifications/read` を呼ぶ。
- 1件ずつ種類に合った文言を出し、押すと対象の画面へ移る。
  - 誘い：`/invites/{id}`
  - 募集：`/broadcasts/{id}`
  - 予定：`/meetups/{id}`
  - 友達：`/friends/{id}`
  - 自動取り消し：ここ暇タブ
  - 連携の失効：`/settings/calendar`
  - 新端末のログイン：友達タブの「アカウント」
- 文言（仮）
  - 誘い：「〇〇さんから誘いが届きました」「〇〇さんは今回は難しいみたい」「〇〇さんから別の時間の提案があります」「今回は見送りになりました」
  - 募集・予定：「〇〇さんが募集しています」「〇〇さんの募集が決まりました」「〇〇さんと予定が成立しました」「予定がなくなりました」「予定から1人抜けました」
  - 友達：「〇〇さんと友達になりました」
  - カレンダー：「カレンダーの予定と重なったここ暇を〇件取り消しました」「カレンダーの連携が切れました」
  - 新端末のログイン：「新しい端末でログインがありました（〇〇）」
  - 名前は公開プロフィールの表示名。表示名がなければ「名前未設定の友達」。
- 友達追加のお知らせ（F-08）
  - 「この人に見せない」のボタンを置く。
  - 押すと `PATCH /friends/{friendId}`（T-02）で「見せない」にし、「見せないにしました」を静かに出す。
  - 友達でなくなっていれば（404）、ボタンを消す。
- 設定（`/settings/notifications`）
  - 友達タブの「アカウント」節からリンクする。
  - 種別ごとのスイッチを5つ置く。
  - この端末でプッシュ通知を受け取る・やめる。
  - 「新しい端末でのログインのお知らせは止められません」と書く。
- 初回設定の「通知の許可」の案内（docs/design/README.md の「入口・初回」）は、初回設定のタスクで作る。このタスクでは設定画面だけ。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `RESEND_API_KEY` | secret | Resend の API キー |
| `VAPID_PRIVATE_KEY` | secret | VAPID の秘密鍵（P-256、PKCS#8） |
| `NOTIFICATION_KEYS` | secret | 購読の endpoint の暗号化の鍵（kid → 32バイトの base64 の JSON。T-06 の鍵とは別） |
| `NOTIFICATION_CURRENT_KID` | vars | 暗号化に使う鍵ID |
| `VAPID_PUBLIC_KEY` | vars | VAPID の公開鍵（base64url、非圧縮の点） |
| `VAPID_SUBJECT` | vars | `mailto:` の連絡先 |
| `MAIL_FROM` | vars | 差出人 |

- ローカルと E2E の鍵は、`scripts/write-e2e-dev-vars.mjs` で作る（T-06 と同じ）。
- 送信ドメインの SPF・DKIM・DMARC は、Resend の手順で DNS に設定する（人が行う）。Terraform で管理するなら、`infra-change` スキルに従って別の PR にする。

### E2E用の偽のメール・プッシュ
- E2E のエントリで、Resend とプッシュの宛先への `fetch` を偽の実装に向ける（T-06 の `e2eFetch` に足す）。
- 偽のプッシュのホストは、`createWorker` に渡す許可リストで足す。
- 送った中身（メールの宛先と件名・本文、プッシュの本文の長さ）は、E2E のエントリだけが作る表に残す。
- `/__e2e__/notifications/sent` で、閲覧者に送ったものを読めるようにする（`E2E_MODE=1` のときだけ）。
- 購読の登録は、テストから `POST /push/subscriptions` に偽の endpoint を送って行う（ブラウザの許可の画面は使わない）。
- CI の本番ビルドの検査に、新しい名前と偽のホスト名を足す。

## 認可と秘匿

### 閲覧者IDの使い方
- すべてのAPIで、閲覧者は `requireAuth` から取る。
- お知らせ・設定・購読は、`user_id = 閲覧者` の条件でだけ読み書きする。

### 他人のデータに届かないこと
- 他人のお知らせは、一覧・未読数・既読（`upTo` に他人のお知らせを渡しても400）のどれにも出ない。
- 他人の購読は消せない。同じ endpoint の付け替えは、登録した本人の行になる。
- consumer の書き込み先は、payload の ID と invitation の関数で決めた受け取り手だけ。

### 区別させない応答
- 「お知らせの作り方」の「秘匿」のとおり。
- 購読の解除は、購読がなくても204。
- 設定で止めた種別も、お知らせ一覧の形は同じ。

### 外部に渡すもの
- プッシュのサービス：本文のないリクエストと VAPID の署名だけ。
- メールの配信サービス：
  - 宛先のメールアドレス
  - 件名
  - お知らせの種類の短い説明
  - 新端末のログインのときだけ、端末の要約とログインの日時
- ログに出すもの：お知らせの種類・送り先の種類（push・email）・結果・状態コードだけ。メールアドレス・endpoint・API キーは出さない。

## テスト計画

### 単体テスト（実装PRで必須）

#### お知らせの作り方
- [ ] 表のイベントごとに、受け取り手・種類・相手が正しい。
  - [ ] `actorId` の人には送らない。
  - [ ] `BroadcastDecided` は募集者に届かない。参加者でない宛先にも届かない。
  - [ ] 募集の `MeetupConfirmed`（`inviteId: null`）では送らない。
  - [ ] 直接の誘いの `MeetupConfirmed` は、成立させた人に届かない。
- [ ] `FriendshipEstablished` は2人の両方に1件ずつ届く。
- [ ] `MeetupLeft` は残った人にだけ届き、抜けた人には届かない。
- [ ] 予定ごと取り消した `MeetupCancelled` は、押した人と先に抜けていた人に届かない。
- [ ] `SessionStarted`
  - [ ] 最初のセッションでは送らない。2つめ以降は、メールだけで送る。
  - [ ] 止める設定と上限に関係しない。
  - [ ] 本文の日時が `occurredAt`。
- [ ] `availability_cancelled` の `count` が `ranges` の数。

#### 秘匿
- [ ] 募集に応じても、応じるのをやめても、お知らせができない。
- [ ] 「見せない」に切り替えても、どのお知らせの有無も変わらない。
- [ ] 自動の断りと手の断りで、お知らせの行と DTO が同じ。

#### 重複と再試行
- [ ] 同じイベントが2回届いても1件。
- [ ] 送る途中で落ちた行は、再試行で送り終える。1日の数は二重に増えない。
- [ ] 退会した人宛てのイベントは、書かずに終わる（投げない）。

#### 送り先と上限
- [ ] 止めた種別はプッシュもメールも送らず、一覧には残る。
- [ ] 購読があればプッシュだけ、なければメールだけ。メールアドレスがなければ送らない。
- [ ] 購読がすべて 404・410 で消えたら、同じお知らせをメールで送る。切り替えたメールはメールの上限で数えられ、再試行でも二重に数えない。
- [ ] 失効・期限切れのセッションの購読には送らず、その購読を消す（使える購読がなければメールに切り替える）。
- [ ] 1日の上限は、プッシュ30件・メール10件で止まる。同時に届いても超えない。日付が変われば戻る。

#### プッシュ
- [ ] 本文がない（`Content-Length: 0`）。
- [ ] ヘッダー（`TTL`・`Authorization: vapid`）と、JWT（`aud`・`exp`・`sub`、ES256）が正しい。
- [ ] 404・410 で購読を消す。5xx・429・タイムアウトで投げる。
- [ ] 400・401・403・413 は一時的でない失敗として扱う。
- [ ] リダイレクトを追わない。

#### メール
- [ ] `Idempotency-Key` がお知らせの ID。
- [ ] 本文に相手の名前・ひとこと・ログイン用のリンクが入らない。
- [ ] 429・5xx・冪等キーの同時の再送で投げる。400・422 は一時的でない失敗として `failed` にする。

#### outbox と掃除
- [ ] 古い outbox の行（通知だけの型で、T-07 を有効にした時刻より前）は送らずに処理済みにする。T-06 の型は流す。有効にした後の行は、遅れても流す。
- [ ] カレンダーの処理が失敗しても、通知は届けたうえで投げる。
- [ ] 90日を過ぎたお知らせと、2日より前の日ごとの数を Cron で掃除する。

#### API
- [ ] 一覧の並び（`inserted_at` の新しい順）・カーソル・未読数。
- [ ] 遅れて届いたお知らせ（`occurredAt` が既読にした行より前）が、一覧の上に出て、未読のまま残る。
- [ ] 既読は `upTo` 以前だけ。他人の `upTo` は400。
- [ ] 他人のお知らせが出ない。
- [ ] 設定の取得・部分更新（行がないときは全部 `true`）。strict でない本文は400。

#### 購読
- [ ] 許可したホストだけ受け付ける。次は400：http、ほかのホスト、似たホスト（`evil-push.apple.com.attacker`・`push.apple.com.evil`）、IP アドレス、ポートの指定、userinfo、長すぎる URL。
- [ ] 上限を超えたら、いちばん古い購読と入れ替える。自分の再登録は数えない。
- [ ] 解除は、購読がなくても204。
- [ ] 同じ endpoint を別の人が登録すると、付け替える。
- [ ] 他人の購読を消せない。
- [ ] ログアウトでそのセッションの購読が、全端末ログアウトで全部が消える。再利用の検知で失効させたセッションの購読も消える。

#### ログ
- [ ] メールアドレス・endpoint・API キー・相手の名前が出ない。

#### Web
- [ ] お知らせ一覧の文言。断り・キャンセルは静かな表示。
- [ ] 未読の数。開いたら `upTo` で既読にする。
- [ ] 友達追加のお知らせの「この人に見せない」。
- [ ] 設定のスイッチ。
- [ ] アプリを開いたときの購読の送り直しと、ログアウトの前の解除。
- [ ] Service Worker：`push` で決まった文言を `waitUntil` で出し、`notificationclick` で `/notifications` を開く。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 誘いのお知らせ（メール）
  - A が B を誘う。
  - B のナビに未読が出て、お知らせ一覧に「A さんから誘いが届きました」が出る。押すと誘いの詳細が開く。
  - B はプッシュの購読がないので、偽のメールが1通届いている。
- [ ] 誘いのお知らせ（プッシュ）
  - C が偽の endpoint を登録する。A が C を誘う。
  - 偽のプッシュが本文なしで1件記録され、メールは届かない。
- [ ] 友達追加と「見せない」
  - A のリンクで B が友達になる。
  - A のお知らせ一覧の「この人に見せない」を押す。
  - B の「みんな」に A のここ暇が出ない。
- [ ] 種別を止める
  - B が設定で「誘い」を止める。A が誘う。
  - お知らせ一覧には出るが、偽のメールは届かない。
- [ ] 新端末のログイン
  - B がもう一度ログインする（2つめのセッション）。
  - 新しい端末でのログインの偽のメールが届く。

## スコープ外
- 通知の文言とデザインの最終版（デザインのタスク）。
- 初回設定の「通知の許可」の案内（初回設定のタスク）。
- 週次通知（Phase 2）。
- ネイティブアプリのプッシュ。
- メールの開封・クリックの計測、`List-Unsubscribe`。
- オフライン対応（Service Worker のキャッシュ）。
- 送信ドメインの DNS の設定そのもの（人が行う）。
- 退会（別タスク。お知らせ・購読・設定は CASCADE で消える）。
- 通知の時間帯の指定（夜は送らない、など）。
- 同じ日の自動取り消しのお知らせを1件にまとめ直すこと。1回の確認ぶんはすでに1件。

## 決定事項（仕様書PRのレビューで合意）
1〜4 は、仕様書を書く前に利用者に確かめた。5〜7 は提案として書き、仕様書PR（pryusei/kokohima-app#36）のレビューで合意した（5 は線の引き方を変えて合意）。

1. メールの配信は Resend を使う。
2. Webプッシュには中身を載せず、アプリのお知らせ一覧で読む。プッシュのサービスに、相手の名前や誘いの内容を渡さない。
3. メールは、プッシュの購読がない人に送る。購読がすべて使えなくなったときも、メールに切り替える。新端末のログインだけは、全員にメールで送る。
4. 種別（誘い・募集・予定・友達・カレンダー）ごとに止められる。
   - 1日の上限はプッシュ30件・メール10件。超えた分はお知らせ一覧だけに残す。
   - 新端末のログインは止められず、上限にも数えない。
5. 通知だけの型の outbox の行のうち、T-07 を有効にした時刻（`notification_settings.started_at`）より前に作られたものは送らない。
6. メールの本文には、お知らせの種類の短い説明だけを書く。相手の名前・ひとこと・エリア・予定の時刻は入れない。新端末のログインは、端末の要約とログインの日時を入れる。
7. 新端末のログインは、端末を区別せず「その人の2つめ以降のセッション」で判定する。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-14 | 初版 | |
| 2026-11-14 | 古い outbox の行の線を「T-07 を有効にした時刻」にする、並びと既読に `inserted_at` を使う、1日の数をチャネルごとに記録する、失効・期限切れのセッションの購読に送らない、endpoint の付け替えのリスクを受け入れる。決定事項5〜7を合意し、合意済みにした | 仕様書PRのレビュー |
