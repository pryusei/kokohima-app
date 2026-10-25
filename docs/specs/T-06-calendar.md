# T-06 仕様書：カレンダー連携（Google）と .ics

- 状態：下書き
- タスク票：docs/tasks/T-06-calendar.md
- 関係する要件：F-02、F-03、F-06、F-13、NF-02、NF-03、NF-04、NF-06、要求定義書「状態遷移とビジネスルール」「セキュリティ設計（カレンダーの認証情報、残りの論点のGoogleのスコープ）」

## 概要
Googleカレンダーとの連携を、ログインとは別の許可として作る。読むのは空き／埋まりだけ、書くのはアプリが作った「ここ暇」カレンダーの予定だけ。
連携した人には、カレンダーの空きから時間帯プリセットの候補を出し、ワンタップでここ暇にする。定期的に埋まりを確かめ、連携後に新しく入った実予定と重なるここ暇を自動で取り消し、その枠への未返答の誘いを「今回は難しい」にする。
成立した予定は、連携している参加者のGoogleカレンダーに書き込み、キャンセル・抜けたときに消す。連携の有無にかかわらず、参加者は .ics でも追加できる。
外部とのやり取りは、候補の表示（読むだけ）と連携・解除を除き、outbox → Queues → consumer で非同期に行う。

## 前提
- コンテキストは `calendar`（`apps/api/src/calendar/{domain,application,infra}`）。腐敗防止層として、Googleの形式を domain に持ち込まず「この時間が埋まっている」「この予定を書き込む・消す」に変換する
- プロバイダは共通のインターフェース（`CalendarProvider`：埋まりの取得、カレンダーの作成、予定の書き込み・削除、失効）の実装として `calendar/infra/google/` に置く。Apple CalDAV は T-09 で `calendar/infra/caldav/` に足す（NF-06。NF-10 の技術検証を先に行う）
- Google の OAuth クライアントはログイン（T-01）と同じものを使い、許可（同意画面）はログインと分ける（F-01）
- ここ暇（`availabilities`・`recurrence_rules`・`recurrence_exceptions`・`presets`）は `availability` のもの。自動取り消しの書き込みは availability の infra の関数で行い、calendar からは application の関数を呼ぶ
- 未返答の誘いを「今回は難しい」にするのは invitation。`AvailabilityCancelledByCalendar` を outbox から受け取って行う
- 外部呼び出しは `AppDeps.fetch` を通す（テストとE2Eで差し替える）。タイムアウトは5秒
- 通知（自動取り消しの本人への通知、連携が切れたことの通知）は T-07。この仕様書では outbox にイベントを書くだけ
- 実装PRで、要求定義書のドメインイベントの表（`CalendarConnected`・`CalendarReauthRequired` の追加。`CalendarBusyDetected` は outbox に書かず、calendar から availability の関数を呼ぶこと）、F-02・F-13 の Apple が T-09 であること、セキュリティ設計の残りの論点「Googleの具体的なスコープの確定」を閉じることと、calendar-integration・invitation-domain スキルを直す

## 用語
| 画面 | コード | 備考 |
| --- | --- | --- |
| カレンダー連携 | CalendarConnection | 1人につきプロバイダごとに1つ |
| カレンダーの空き | FreeSlot（候補） | 時間帯プリセットの枠で、埋まりと重ならないもの |
| 埋まり | Busy | 予定の中身を持たない時刻の範囲 |
| 自動取り消し | AvailabilityCancelledByCalendar | 本人には T-07 で通知。誘いの相手には理由を伝えない |
| 「ここ暇」カレンダー | （Googleのセカンダリカレンダー） | アプリが作り、成立した予定だけを書く |

## Googleのスコープ（決定事項1）
- `https://www.googleapis.com/auth/calendar.freebusy`：空き／埋まりの取得（freeBusy.query）だけ。予定の一覧・中身は読めない
- `https://www.googleapis.com/auth/calendar.app.created`：アプリが作ったセカンダリカレンダーの作成と、その中の予定の管理だけ。利用者のほかのカレンダーには書けない
- この2つのどちらかが同意画面で外されたら、連携は失敗にする（トークンを失効させ、保存しない）
- 埋まりは `primary`（メインのカレンダー）だけで確かめる。カレンダーの一覧を読むスコープを取らないため（決定事項2）。「ここ暇」カレンダーは確かめる対象に入らないので、書き込んだ予定で自分のここ暇が取り消されることはない
- スコープの名前と範囲、freeBusy.query の範囲の上限、予定IDに使える文字は、実装時にGoogleの公式ドキュメントで確認する（このPRを書いた環境では公式のページに接続できず、検索の結果で確かめた）。食い違いがあれば実装PRで仕様書を直す

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/calendar.ts`。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/calendar/google/authorizations` | Bearer | なし | 200：`{ authorizeUrl }`、結びつけCookie | 401、429 `rate_limited` |
| GET | `/api/v1/calendar/google/callback` | なし（state と結びつけCookie） | query：`code`、`state`（または `error`） | 303：`/settings/calendar?calendar=connected` か `?calendar=failed` | （常に303） |
| GET | `/api/v1/calendar/connections` | Bearer | なし | 200：`calendarConnectionsSchema` | 401 |
| DELETE | `/api/v1/calendar/connections/google` | Bearer | なし | 204 | 404（連携していない） |
| GET | `/api/v1/calendar/free-slots` | Bearer | query：`from`、`to`（ISO 8601。最長14日） | 200：`freeSlotsSchema` | 400 |
| GET | `/api/v1/meetups/{id}/ics` | Bearer | なし | 200：`text/calendar; charset=utf-8` | 404（参加者でない・抜けた） |

### 入力
- 連携の開始・解除は本文なし（本文があっても読まない）
- `from`・`to`：T-03 の範囲と同じ規則（ISO 8601 UTC、`from < to`、最長14日）。過去の部分は候補を作らない

### 出力
- `calendarConnectionsSchema`：`{ google: { status, connectedAt } }`
  - `status`：`connected`（使える）・`needs_reauth`（Google側で失効した。もう一度連携が必要）・`none`（連携していない）
  - `connectedAt`：連携した日時。`none` のときは `null`
  - Googleのアカウントのメールアドレスや名前は返さない・保存しない（決定事項3）
- `freeSlotsSchema`：`{ status, items, nextCursor: null }`
  - `status`：`ok`・`none`（連携していない）・`needs_reauth`・`unavailable`（Googleが失敗・タイムアウトした）。`ok` 以外の `items` は空
  - `items`：`{ date, preset, startsAt, endsAt }` の配列。`date` は閲覧者のタイムゾーンでの日付、`preset` は `day`・`evening`・`night`。開始日時の古い順
  - ワンタップの作成は、T-03 の `POST /api/v1/availabilities` に `{ date, preset }` を送る（新しい作成のAPIは作らない）
- `.ics`：RFC 5545 の `VCALENDAR` に `VEVENT` を1つ（「振る舞い」の .ics）。`Content-Disposition: attachment; filename="kokohima-<meetupId>.ics"`、`Cache-Control: no-store`

### 例外
- 連携の開始を `GET` の画面遷移でなく `POST` にする。アクセストークンはメモリだけにあり、画面遷移ではBearerを送れないため。受け取った `authorizeUrl` へフロントが画面遷移する
- コールバックはBearerなしの `GET`。Googleからのリダイレクトで届くため。閲覧者は `state` に結びつけた利用者で、結びつけCookieが同じブラウザかを確かめる（T-01 と同じ）
- 候補の表示は、APIハンドラからGoogleを直接呼ぶ。CLAUDE.md の「外部連携はoutbox経由」は書き込み・通知が対象で、これは閲覧者がその場で見る読み取りのため。失敗しても5xxにせず、200の `status: unavailable` で返す（ここ暇の画面を止めない）
- 解除は、APIハンドラからGoogleの失効（revoke）を直接呼ぶ。トークンをすぐに消すため、outbox に暗号化したトークンを残さない。失効が失敗しても、保存したトークンは必ず消して204を返す
- 連携の開始の上限：1人につき10分に10回。超えたら429 `rate_limited`（`Retry-After`）。KV がまだないので、`calendar_oauth_states` の行の数で数える
- `.ics` は JSON でなく `text/calendar` を返す。エラーは他と同じ problem+json
- `Idempotency-Key` は受け付けない（T-02 の決定事項6のとおり別タスク）。連携の開始は何度やり直しても害がなく、解除は2回目が404になるだけ

## データ
マイグレーション `apps/api/migrations/0006_calendar.sql`。日時はUnixミリ秒。

- `calendar_connections`
  - `user_id`（→ users、ON DELETE CASCADE）、`provider`（`google`）、主キーは `(user_id, provider)`
  - `status`：`active`・`needs_reauth`
  - `refresh_token_enc`：暗号化した更新用トークン（「トークンの暗号化」）。`needs_reauth` のときは NULL
  - `calendar_id`：「ここ暇」カレンダーのID。まだ作っていなければ NULL
  - `connected_at`、`updated_at`
  - `busy_snapshot`：前回確かめた埋まり（`[[開始, 終了], ...]` の JSON。予定の中身は持たない）、`snapshot_from`・`snapshot_to`（その範囲）。まだ確かめていなければ NULL
  - `last_synced_at`、`sync_lease_until`（同じ人の確認を同時に2つ走らせないための期限）
  - インデックス：`(status, last_synced_at)`
- `calendar_oauth_states`
  - `state_hash`（主キー）、`binding_hash`、`user_id`（→ users、CASCADE）、`provider`、`code_verifier`、`expires_at`（10分）、`created_at`
  - インデックス：`(user_id, created_at)`（開始の回数の上限）、`(expires_at)`
- 既存の `outbox.processed_at` を「Queue に渡した日時」として使う（列の追加なし）
- アクセストークンは保存しない（使うたびに更新用トークンで取る）

### トークンの暗号化（NF-04）
- AES-256-GCM（WebCrypto）。鍵は secret `CALENDAR_TOKEN_KEYS`（`{ "<kid>": "<32バイトのbase64>" }` の JSON）、暗号化に使う鍵IDは vars `CALENDAR_TOKEN_CURRENT_KID`
- 保存の形：`v1.<kid>.<iv（12バイト、base64url）>.<暗号文（base64url）>`。復号は行の `kid` の鍵で行う（鍵を切り替えても古い行を読める）
- 追加の認証データ（AAD）に `calendar:<provider>:<user_id>` を入れ、別の人の行に写した暗号文を復号できないようにする
- 実装は `apps/api/src/shared/crypto.ts` に `encryptSecret`・`decryptSecret` を足す（自作の暗号はしない。WebCrypto だけを使う）

## 振る舞い

### 連携の開始
1. 閲覧者の `calendar_oauth_states` の直近10分の行が10以上なら429
2. `state`・`binding`・PKCE の `code_verifier`（各32バイト）を作り、`state` と `binding` のハッシュ、`code_verifier`、閲覧者の `user_id` を保存する（10分）
3. 結びつけCookie `__Host-kh_cal=<binding>` を設定する（HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600）。T-01 の `__Host-kh_oauth` とは別の名前にする（ログインと同時に進めても壊さない）
4. `authorizeUrl` を返す：`scope`（上の2つ）、`access_type=offline`、`prompt=consent`（毎回、更新用トークンを受け取る）、`code_challenge_method=S256`、`state`、`redirect_uri`（`/api/v1/calendar/google/callback`）。`include_granted_scopes` は付けない（ログインの許可と混ぜない）

### コールバック
1. `state` のハッシュで `calendar_oauth_states` を条件付きで削除して取り出す（`DELETE ... RETURNING`）。ない・期限切れは失敗
2. 結びつけCookieのハッシュが `binding_hash` と定数時間比較で一致しなければ失敗（攻撃者が始めた連携を被害者のブラウザで完了させ、被害者の埋まりを攻撃者のアカウントにつなぐことを防ぐ）。結果にかかわらず結びつけCookieを消す
3. `error` があれば（同意画面で断った）失敗
4. 認可コードを `code_verifier` とクライアントの認証情報でトークンエンドポイントに送る。応答の `scope` に2つのスコープがそろっていなければ、受け取ったトークンを失効させて失敗
5. 更新用トークンを暗号化し、`calendar_connections` に `status = 'active'` で書く（`INSERT ... ON CONFLICT DO UPDATE`。`calendar_id`・`busy_snapshot` などは NULL に戻す）。前の行に `active` の更新用トークンがあれば、書いた後にそのトークンを失効させる（失敗しても続ける）。同じ batch で outbox に `CalendarConnected`（`{ userId, provider, occurredAt }`）を書く
6. `/settings/calendar?calendar=connected` へ303。失敗はすべて `?calendar=failed` へ303。理由は区別しない
- ログには失敗の種類だけを出し、コード・トークン・Googleの応答の本文は出さない

### 連携の状態と解除
- 状態は `calendar_connections` の閲覧者の行だけから作る（行がなければ `none`）
- 解除：閲覧者の行を取り出して（`DELETE ... RETURNING`）、更新用トークンがあれば復号してGoogleの revoke に送る（タイムアウト5秒、再試行なし）。行がなければ404
- 解除しても、すでに「ここ暇」カレンダーに書いた予定と、カレンダーそのものは残す（利用者のカレンダーなので、こちらから消さない。決定事項4）
- 解除の後に届いた予定のイベントは、連携がないので何もしない

### アクセストークンの取得と失効の検知
- 使うたびに、更新用トークンでアクセストークンを取る（同じ処理の中では使い回す）
- トークンエンドポイントが `invalid_grant` を返したら、`status = 'needs_reauth'`、`refresh_token_enc = NULL` にし（`WHERE status = 'active'` の条件付き UPDATE）、outbox に `CalendarReauthRequired`（`{ userId, provider, occurredAt }`。通知は T-07）を書く。それ以外の失敗は一時的な失敗として扱う（再試行）
- `needs_reauth` の人には、候補・確認・書き込みのどれもGoogleを呼ばない

### カレンダーの空き（候補）
1. 連携が `active` でなければ、`status` を `none`・`needs_reauth` にして空で返す
2. `from`〜`to` を、閲覧者のタイムゾーンの日付に分ける。日付ごとに閲覧者の現在のプリセット（昼・夕方・夜）の枠を作る（T-03 の変換と同じ関数）
3. Googleの freeBusy.query（`primary`、`from`〜`to`）で埋まりを取る。失敗・5秒のタイムアウトは `unavailable`
4. 次の枠を候補から外す：開始が現在以前、埋まりと1分以上重なる、自分のここ暇（手動とくり返しの展開）と1分以上重なる（作っても T-03 で409になるため）
5. 埋まりは保存しない（自動取り消しの記録は「定期の確認」だけが書く）

### 定期の確認と自動取り消し（決定事項5・6）
- Cron（15分ごと）で、`status = 'active'` で `last_synced_at` が15分以上前（または NULL）の連携を古い順に最大200件選び、1人ずつ Queue に `CalendarSyncRequested`（`{ userId, provider }`）を送る（outbox には書かない。状態の変化ではないため）
- consumer は次の順に処理する
  1. 確認の権利を取る：`UPDATE calendar_connections SET sync_lease_until = now + 5分 WHERE user_id = ? AND provider = ? AND status = 'active' AND (sync_lease_until IS NULL OR sync_lease_until < now)`。0行なら何もしない
  2. 範囲 `[now, now + 60日)` の埋まりを freeBusy.query で取る（ここ暇を作れるのが60日先までのため。T-03）
  3. 前回の記録がなければ（連携した直後）、記録だけを書いて終わる。連携した時点で入っている予定では、ここ暇を取り消さない
  4. 新しく入った埋まり＝（今回の埋まり）から（前回の埋まり）を引いた部分のうち、前回の範囲 `[snapshot_from, snapshot_to)` に入る部分。範囲がずれて新しく見えるようになった先の日付は、新しく入ったものとして扱わない
  5. 自分のここ暇のうち、終了が現在より後で、新しく入った埋まりと1分以上重なるものを取り消す
     - 手動の枠：行を削除する（T-03 の取り消しと同じ）
     - くり返しの展開：その日を例外に足す（`recurrence_exceptions` に `INSERT OR IGNORE`。T-03 の「この日だけ外す」と同じ）
  6. 5の書き込みと、記録の更新（`busy_snapshot`・`snapshot_from`・`snapshot_to`・`last_synced_at`、`sync_lease_until = NULL`）と、取り消しがあれば outbox の `AvailabilityCancelledByCalendar` を1つの batch で書く。記録の更新は `WHERE sync_lease_until = <1で書いた値>` の条件付きにし、0行なら（権利が切れて別の確認が書いた）batch の他の文も書かない（T-04 の `transition_id` と同じく `EXISTS` で確かめる）
- 新しい埋まりの判定と、取り消す枠の選び方は `calendar/domain` と `availability/domain` の純粋な関数にする（重なりは T-03 の関数を使う）
- ここ暇の作成時に、埋まりと重なっていても止めない（予定を知ったうえで作ることもあるため。候補には出さない）
- 一時的な失敗は Queue の再試行に任せる。権利の期限（5分）が切れれば次の確認で取り直せる

### 未返答の誘いの自動の「今回は難しい」
- `AvailabilityCancelledByCalendar` の payload：`{ userId, ranges: [{ startsAt, endsAt }], occurredAt }`（取り消した枠の時刻だけ。1回の確認で取り消した枠をまとめて1つにする。NF-07）
- invitation の consumer は、受信者が `userId`、`status = 'pending'`、返事の期限前で、時間が `ranges` のどれかと1分以上重なる誘いを、手で「今回は難しい」を押したときと同じ遷移で `declined` にする（T-04 の `respondInvite` の decline。outbox の `DirectInviteDeclined` も同じ形）
- 送信者に返す誘いの形・項目・時刻の扱いは、手で断ったときと同じにする（自動で断ったことを区別させない。理由は保存も送信もしない）
- `counter_proposed`（受信者が代わりの時間を出し、送信者の判断を待っている）と、募集への応答は変えない（決定事項7）
- 条件付き UPDATE なので、同じイベントが2回届いても2回目は何もしない

### 成立した予定のGoogleカレンダーへの書き込み（決定事項8）
- consumer は `MeetupConfirmed`・`MeetupCancelled`・`MeetupLeft`・`CalendarConnected` を受け取ったら、対象の予定ごとに「あるべき状態」にそろえる（同じイベントが何度届いても結果が同じ）
  - 対象：`MeetupConfirmed`・`MeetupCancelled`・`MeetupLeft` は payload の予定。`CalendarConnected` はその人が参加者（抜けていない）で、終了が現在より後の成立した予定（最大100件）
  - 予定ごとに、参加者（抜けた人を含む。`CalendarConnected` はその人だけ）のうち連携が `active` の人について、書くべきなら書き、書くべきでなければ消す
  - 書くべき：予定が `confirmed`、その人が抜けていない、予定の終了が現在より後
- 「ここ暇」カレンダーがなければ作る（名前「ここ暇」、タイムゾーンは `users.timezone`）。`calendar_id` は `WHERE calendar_id IS NULL` の条件付き UPDATE で書き、0行なら（同時に別の処理が作った）作ったカレンダーを消して、保存されている方を使う。カレンダーが404（利用者が消した）なら作り直す
- 予定のIDは、予定のIDから決まる値（`kh` ＋ UUID のハイフンを除いた16進。Googleの予定IDに使える文字の範囲）。作成が「すでにある」で失敗したら更新する。削除が404・410なら成功として扱う
- 書く内容
  - タイトル：「ここ暇：<自分以外の参加者の表示名を「、」でつないだもの>」（抜けた人を除く。表示名がない人は「友達」）
  - 開始・終了、場所：エリア（なければ空）、説明：アプリの予定の詳細のURL（`APP_ORIGIN/meetups/<id>`）とリンク（あれば）
  - ひとことは書かない（決定事項8）
- 参加者が抜けたら、残った参加者の予定もタイトルを書き直す
- 予定のイベントの再試行は、人ごとではなく1つのイベントごと。途中まで書けていても、そろえ直すので二重にならない

### outbox を Queues に流す
- Cron（1分ごと）で、`processed_at IS NULL` の行を作成日時の古い順に最大100件、`UPDATE outbox SET processed_at = ? WHERE id IN (…) AND processed_at IS NULL RETURNING …` で取り出し、Queue に `sendBatch` する。送れなかったら、その行の `processed_at` を NULL に戻す
- Queue のメッセージ：`{ kind: "outbox", id, type, payload }` か `{ kind: "calendar_sync", userId, provider }`
- consumer は `type` で処理を振り分ける。この仕様書で処理するのは上のイベントだけで、ほかの型（通知の対象など。T-07）は何もせずに受け取ったことにする
- 再試行は最大5回（間隔を広げる）。それでも失敗したら退避キューに送る。退避キューのメッセージは処理しない（ログに型と `id` だけを出す）
- ログに payload の中身（ID以外）・トークン・Googleの応答の本文を出さない

### .ics
- 閲覧者が予定の参加者で、抜けていないときだけ返す（`findMeetupFor` と同じ SQL の条件に `left_at IS NULL` を足す）。それ以外は404（予定がない・参加者でない・抜けたを区別しない）
- `confirmed` の予定は `STATUS:CONFIRMED`、`cancelled` は `STATUS:CANCELLED`（取り込み済みの人のカレンダーで消せるように。同じ `UID`）
- 中身：`UID:<meetupId>@kokohima`、`DTSTAMP`、`DTSTART`・`DTEND`（UTC）、`SUMMARY`・`LOCATION`・`DESCRIPTION`（Googleに書く内容と同じ）、`SEQUENCE`（状態が変わるたびに増える値として、キャンセル済みなら1、それ以外は0）
- 文字列は RFC 5545 のとおりエスケープする（`\`・`;`・`,`・改行）。行は75オクテットで折り返す。ユーザーが入れた文字列で別のプロパティや `VEVENT` を作れないことをテストする

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）
- 設定のカレンダー連携（`/settings/calendar`。友達タブの「アカウント」節からリンク）
  - Google：状態（「連携していません」「連携中」「もう一度連携してください」）と、「Googleカレンダーと連携」「連携をやめる」のボタン
  - 「連携」で `POST /authorizations` を呼び、`authorizeUrl` へ画面遷移する。戻ってきた `?calendar=connected` は「連携しました」、`failed` は「連携できませんでした。もう一度お試しください」を静かに出す（赤を使わない）
  - 読むのは空き／埋まりだけで、予定の中身は読まないことを1文で書く
  - Apple：「Appleカレンダーは準備中です。成立した予定は .ics で追加できます」
- ここ暇タブの「カレンダーの空き」（連携している人だけ）：今日から7日分の候補を「6/1（土）夜 19:00〜23:00」の形で並べ、押すとここ暇になる（楽観的更新はしない。成功したら自分の一覧と候補を読み直す）。`unavailable` は「カレンダーを読み込めませんでした」、`needs_reauth` は設定へのリンクを静かに出す
- 予定の詳細：「カレンダーに追加（.ics）」のボタン。APIクライアントで取得してダウンロードさせる（Bearer が要るため、`<a href>` にしない）

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `CALENDAR_TOKEN_KEYS` | secret | トークンの暗号化の鍵（kid → 32バイトのbase64 の JSON） |
| `CALENDAR_TOKEN_CURRENT_KID` | vars | 暗号化に使う鍵ID |
| `JOBS` | Queue（producer・consumer） | outbox と確認のメッセージ。退避キュー付き |
| Cron | triggers | `* * * * *`（outbox）、`*/15 * * * *`（確認の割り当て） |

- `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` は T-01 のものを使う。リダイレクト先 `/api/v1/calendar/google/callback` を Google Cloud のクライアントに登録する（人が行う）
- Queue は `infra/terraform` に足し（本体と退避キュー、staging・prod）、wrangler の各環境にバインディングと Cron を書く。`infra-change` スキルに従い、apply・deploy はしない
- 本番のエントリ（`src/index.ts`）は `fetch`・`scheduled`・`queue` を export する

### E2E用の偽のGoogle
- E2E では本物のGoogleを呼ばない。E2E のエントリ（`src/e2e/entry.ts`）で、Google への `fetch` を偽の実装に差し替える（`src/e2e/` に置き、本番のエントリから import しない）
- 偽の認可画面 `/__e2e__/calendar/google/authorize`（同意したことにして、コールバックへリダイレクトする）、偽の埋まりを設定する `/__e2e__/calendar/busy`、確認と outbox の処理をすぐに行う `/__e2e__/calendar/sync`・`/__e2e__/outbox/drain`。どれも `E2E_MODE=1` のときだけ有効
- 偽の実装の状態は、E2E のエントリだけが作る表に置く（本番のマイグレーションに入れない）
- CI の本番ビルドの検査に、新しい経路の名前を足す

## 認可と秘匿
- 閲覧者IDの使い方：すべてのAPIで、閲覧者は `requireAuth`（コールバックは `state` に結びつけた利用者）から取る。パスや本文の利用者IDは使わない。連携・候補・解除は閲覧者自身の `calendar_connections` の行だけを SQL の条件で読む
- 他人のデータに届かないことの保証
  - 連携の行は `user_id = 閲覧者` の条件でだけ読む・消す。候補は閲覧者のトークンでだけGoogleを呼ぶ
  - `.ics` は、閲覧者が抜けていない参加者である予定だけを SQL の条件で読む
  - 別の人の暗号文を写しても、AAD が違うので復号できない
  - consumer は payload の `userId`・`meetupId` を使うが、書き込みの対象は SQL で読んだ参加者と、その人の連携だけ
- 予定の中身：Googleから読むのは freeBusy.query の埋まり（開始・終了）だけ。予定の一覧・タイトル・場所・参加者を読むAPIを呼ばない（スコープでもできない）。保存するのも埋まりの時刻だけ
- 区別させない応答
  - 自動の「今回は難しい」は、手で断ったときと送信者への応答・イベントが同じ
  - 友達には、閲覧者が連携しているかどうか、ここ暇が自動で取り消されたかどうかを返さない（ここ暇が消えるだけ）
  - コールバックの失敗はすべて同じ `?calendar=failed`
- トークン：更新用トークンは暗号化して保存し、アクセストークンは保存しない。ログ・エラー・problem+json の `detail` に出さない。ブラウザに渡さない

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 暗号化：往復できる、鍵IDで古い鍵の行を復号できる、AAD が違うと失敗する、改ざんで失敗する、毎回 IV が違う
- [ ] 連携の開始：`authorizeUrl` のパラメータ（スコープ2つ、`access_type=offline`、`prompt=consent`、S256、`include_granted_scopes` なし）、結びつけCookie、10分に10回の429
- [ ] コールバック：成功で暗号化した行と `CalendarConnected`、`state` の使い回し・期限切れ・別のブラウザ（Cookie なし・違う）・`error`・スコープ不足（失効を呼ぶ）がすべて同じ `failed`、連携し直しで古いトークンを失効させる
- [ ] 状態：`none`・`connected`・`needs_reauth`。他人の連携が見えない
- [ ] 解除：行が消え revoke を呼ぶ、revoke の失敗・タイムアウトでも204で行が消える、連携していなければ404、他人の連携を消せない
- [ ] 候補：プリセットの枠、埋まりと重なる枠・過去の枠・自分のここ暇と重なる枠を外す、タイムゾーンの日付の分け方、`unavailable`（失敗・タイムアウト）・`none`・`needs_reauth`、14日を超える範囲は400、Googleへの呼び出しが freeBusy.query だけ
- [ ] 新しい埋まりの判定（domain）：初回は取り消さない、前回にない埋まりだけ、前回の範囲の外は除く、埋まりが広がった・つながった・消えた場合、1分の重なりの境目
- [ ] 自動取り消し：手動の枠の削除、くり返しの例外の追加、終わった枠は対象外、`AvailabilityCancelledByCalendar` を1つにまとめる、権利（lease）が取れないときは何もしない、権利が切れたら batch の他の文も書かない
- [ ] 自動の「今回は難しい」：重なる `pending` だけが `declined` と `DirectInviteDeclined`、`counter_proposed`・期限切れ・別の人宛て・重ならない誘いは変わらない、2回届いても1回だけ、送信者への応答が手で断ったときと同じ
- [ ] `invalid_grant` で `needs_reauth` と `CalendarReauthRequired`、その後はGoogleを呼ばない
- [ ] 書き込み：成立で連携している参加者だけに書く、キャンセルで消す、抜けた人の予定を消して残りの人のタイトルを直す、2回届いても同じ、「すでにある」は更新、404・410の削除は成功、カレンダーがなければ作る・同時に作ったら片方を消す、`CalendarConnected` でこれからの予定を書く、ひとことを書かない
- [ ] outbox の取り出し：最大100件、二重に取り出さない、送れなければ戻す、知らない型は何もしない
- [ ] .ics：参加者は取得できる、参加者でない・抜けた・存在しないは同じ404、キャンセル済みは `STATUS:CANCELLED`、エスケープと折り返し（改行・`;`・`,` を入れても `VEVENT` が1つ）
- [ ] ログに、トークン・コード・Googleの応答の本文が出ない
- [ ] Web：設定の状態の表示と連携・解除、`?calendar=` の表示、候補のワンタップでここ暇を作る、`unavailable` の表示、.ics のダウンロード

### E2Eテスト（対象にする利用者の流れ）
- [ ] 連携：設定で「Googleカレンダーと連携」→ 偽の認可画面 → 「連携中」になる → 「連携をやめる」で「連携していません」に戻る
- [ ] 候補：連携した人のここ暇タブに候補が出て、押すとここ暇になる。偽の埋まりと重なる時間帯は出ない
- [ ] 自動取り消し：A が連携してここ暇を作り、B が A を誘う → 偽の埋まりを足して確認を実行 → A のここ暇が消え、B の誘いが「今回は難しい」になる
- [ ] .ics：成立した予定の詳細から .ics をダウンロードでき、中身に予定の時刻がある

## スコープ外
- Apple CalDAV（T-09。NF-10 の技術検証を先に行う）、Outlook
- 通知（T-07）。`AvailabilityCancelledByCalendar`・`CalendarReauthRequired` の本人への通知もここ
- Googleの変更通知（Webhook）。`calendar.freebusy` のスコープでは予定の変更を見張れない（見張るには予定を読むスコープが要る）ため、定期の確認で代える（決定事項5）
- メインのカレンダー以外の埋まり（決定事項2）
- 誘い・募集を作る画面での空きの表示
- `Idempotency-Key`、KV でのレート制限（別タスク）
- 監査ログ（カレンダー連携の記録。別タスク）
- Googleの審査（一般公開まで。テスト中の公開状態では、更新用トークンが7日で失効することがある。その場合は `needs_reauth` になる）
- 最終的な画面デザイン

## 決定事項（仕様書PRのレビューで合意）
この仕様書は、利用者に事前に確かめずに提案として書いた。PRのレビューで合意するか、直す。

1. Googleのスコープは `calendar.freebusy` と `calendar.app.created` の2つにし、どちらかが外されたら連携しない（予定の作成は、利用者のカレンダーではなくアプリが作る「ここ暇」カレンダーに書く）
2. 埋まりはメインのカレンダーだけで確かめる（カレンダーの一覧を読むスコープを取らない）
3. Googleのアカウントのメールアドレス・名前は取らない・保存しない（設定には「連携中」だけを出す）
4. 解除しても、書いた予定と「ここ暇」カレンダーは消さない
5. 自動取り消しは、Webhook でなく15分ごとの確認で行う。60日先まで確かめる
6. 取り消すのは、連携後に新しく入った埋まりと1分以上重なるここ暇だけ（連携した時点の予定や、予定を知ったうえで作ったここ暇は取り消さない）。前回の埋まりを時刻だけ保存する
7. 自動で「今回は難しい」にするのは `pending` の誘いだけ。`counter_proposed` と募集の応答は変えない
8. Googleに書く内容は、タイトル（「ここ暇：相手の名前」）・時刻・エリア・アプリへのリンク・誘いのリンク。ひとことは書かない
9. このタスクはGoogleだけにし、Apple CalDAV は NF-10 の技術検証とあわせて T-09 にする。それまでの Apple の人と、連携しない人には .ics を出す

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-25 | 初版 | |
