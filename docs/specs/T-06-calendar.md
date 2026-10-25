# T-06 仕様書：カレンダー連携（Google）と .ics

- 状態：下書き
- タスク票：docs/tasks/T-06-calendar.md
- 関係する要件：F-02、F-03、F-06、F-13、NF-02、NF-03、NF-04、NF-06、要求定義書「状態遷移とビジネスルール」「セキュリティ設計（カレンダーの認証情報、残りの論点のGoogleのスコープ）」

## 概要
Googleカレンダーとの連携を、ログインとは別の許可として作る。Googleから読むのは空き／埋まりだけで、書き込むのはアプリが作った「ここ暇」カレンダーの予定だけ。
- 候補：連携した人には、カレンダーの空きから時間帯プリセットの候補を出し、ワンタップでここ暇にできるようにする。
- 自動取り消し：定期的に埋まりを確かめる。連携後に新しく入った実予定と重なるここ暇は自動で取り消し、その枠への未返答の誘いは「今回は難しい」にする。
- 書き込み：成立した予定は、連携している参加者のGoogleカレンダーに書き込む。キャンセルされたときと抜けたときは消す。
- .ics：連携の有無にかかわらず、参加者は .ics でも予定を追加できる。

外部とのやり取りは outbox → Queues → consumer の非同期で行う。例外は、候補の表示（読むだけ）と、連携・解除の処理（トークンの交換・失効）。

## 前提

### コンテキストの分担
- このタスクのコンテキストは `calendar`（`apps/api/src/calendar/{domain,application,infra}`）。腐敗防止層として、Googleの形式を domain に持ち込まず、「この時間が埋まっている」「この予定を書き込む・消す」に変換する。
- プロバイダは共通のインターフェース `CalendarProvider` の実装として、`calendar/infra/google/` に置く。
  - インターフェースの中身：埋まりの取得、カレンダーの作成・確認、予定の書き込み・削除、失効。
  - Apple CalDAV は T-09 で `calendar/infra/caldav/` に足す（NF-06。NF-10 の技術検証を先に行う。T-09 のタスク票は実装PRで足す）。
- ほかのコンテキストの domain は import しない（T-04 と同じ）。
  - calendar/domain が持つのは、埋まりの区間の計算（新しく入った埋まりの判定）だけ。
  - プリセットの枠の作成・重なり・くり返しの展開は availability が持つ。calendar の application から、availability の application の関数を呼ぶ。
- ここ暇（`availabilities`・`recurrence_rules`・`recurrence_exceptions`・`presets`）は `availability` のもの。
  - 自動取り消しの書き込み文は、availability の infra の関数で作る。この関数は、条件（guard）を受け取って `D1PreparedStatement[]` を返す。
  - calendar は、その文を自分の batch に入れる（「定期の確認と自動取り消し」）。
- 未返答の誘いを「今回は難しい」にするのは invitation。`AvailabilityCancelledByCalendar` を outbox から受け取って行う。

### 外部とのつなぎ方
- Google の OAuth クライアントはログイン（T-01）と同じものを使い、許可（同意画面）はログインと分ける（F-01）。
- 外部呼び出しは `AppDeps.fetch` を通す。Google の各エンドポイントの URL も `AppDeps`（`google.endpoints`）に置き、テストとE2Eで差し替える。
- 外部呼び出しのタイムアウトは5秒。

### 他タスクとの関係
- 通知は T-07。この仕様書では、通知のもとになるイベントを outbox に書くだけ。
  - T-07 で通知するもの：自動取り消しの本人への通知、連携が切れたことの通知。
- 実装PRで、次の文書を直す。
  - 要求定義書
    - ドメインイベントの表に `CalendarConnected`・`CalendarReauthRequired` を足す。
    - `CalendarBusyDetected` は outbox に書かず、calendar から availability の関数を呼ぶことにする。
    - アーキテクチャの図から、Googleの変更通知（`G -- 変更通知 --> A`）を外す。
    - F-02・F-13 の Apple は T-09 で扱うと書く。
    - セキュリティ設計の残りの論点「Googleの具体的なスコープの確定」を閉じる。
  - calendar-integration スキル：Webhook の行を「使わない（定期の確認）」に直す。
  - invitation-domain スキル。
- 退会（別タスク）に申し送る：行を CASCADE で消す前に、Google の revoke を呼ぶ。

## 用語
| 画面 | コード | 備考 |
| --- | --- | --- |
| カレンダー連携 | CalendarConnection | 1人につきプロバイダごとに1つ |
| カレンダーの空き | FreeSlot（候補） | 時間帯プリセットの枠のうち、埋まりと重ならないもの |
| 埋まり | Busy | 予定の中身を持たない時刻の範囲 |
| 自動取り消し | AvailabilityCancelledByCalendar | 本人には T-07 で通知する。誘いの相手には理由を伝えない |
| 「ここ暇」カレンダー | （Googleのセカンダリカレンダー） | アプリが作り、成立した予定だけを書く |

## Googleのスコープ（確認事項1）
- 使うスコープは次の2つ。
  - `https://www.googleapis.com/auth/calendar.freebusy`：空き／埋まりの取得（freeBusy.query）だけができる。予定の一覧・中身は読めない。
  - `https://www.googleapis.com/auth/calendar.app.created`：アプリが作ったセカンダリカレンダーの作成と、その中の予定の管理だけができる。利用者のほかのカレンダーには書けない。
- 同意画面でどちらかが外されたら、連携は失敗にする。受け取ったトークンは失効させ、保存しない。
- 埋まりは `primary`（メインのカレンダー）だけで確かめる（確認事項2）。
  - カレンダーの一覧を読むスコープを取らないため。
  - 「ここ暇」カレンダーは確かめる対象に入らない。そのため、書き込んだ予定で自分のここ暇が取り消されることはない。
- 実装の最初に、Googleの公式ドキュメントで次のことを確かめる。食い違いがあれば実装PRで仕様書を直す。
  - スコープの名前と範囲
  - freeBusy.query の範囲の上限と、カレンダーごとのエラーの形
  - 予定IDに使える文字
  - revoke が同じクライアントの許可全体を失効させるか
- このPRを書いた環境からは公式のページに接続できず、スコープは検索の結果で確かめた。

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。スキーマは `packages/shared/src/schemas/calendar.ts` に置く。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/calendar/google/authorizations` | Bearer（`requireActiveSession`） | なし | 200：`{ authorizeUrl }`、結びつけCookie | 401、429 `rate_limited` |
| GET | `/api/v1/calendar/google/callback` | なし（state と結びつけCookie） | query：`code`、`state`（または `error`） | 303：`/settings/calendar?calendar=connected` か `?calendar=failed` | （常に303） |
| GET | `/api/v1/calendar/connections` | Bearer | なし | 200：`calendarConnectionsSchema` | 401 |
| DELETE | `/api/v1/calendar/connections/google` | Bearer（`requireActiveSession`） | なし | 204 | 401、404（連携していない） |
| GET | `/api/v1/calendar/free-slots` | Bearer | query：`from`、`to`（ISO 8601。最長14日） | 200：`freeSlotsSchema` | 400、401 |
| POST | `/api/v1/meetups/{id}/ics-links` | Bearer | なし | 200：`{ url, expiresAt }` | 401、404（参加者でない・抜けた） |
| GET | `/api/v1/ics/{token}` | なし（URL のトークン） | なし | 200：`text/calendar; charset=utf-8` | 404（トークンがない・期限切れ・参加者でなくなった） |

### 入力
- 連携の開始・解除・.ics のリンクの発行は本文なし（本文があっても読まない）。
- `from`・`to` は T-03 の範囲と同じ規則：ISO 8601 UTC、`from < to`、最長14日。過去の部分には候補を作らない。

### 出力
- `calendarConnectionsSchema`：`{ google: { status, connectedAt } }`
  - `status` は次のどれか。
    - `connected`：使える。
    - `needs_reauth`：Google側で失効した。もう一度連携が必要。
    - `none`：連携していない。
  - DB の `status` との対応：`active` は `connected`、`needs_reauth` は `needs_reauth`、`disconnected` と行がない場合は `none`。
  - `connectedAt`：連携した日時。`none` のときは `null`。
  - Googleのアカウントのメールアドレスや名前は、返さないし保存もしない（確認事項3）。
- `freeSlotsSchema`：`{ status, items, nextCursor: null }`
  - `status` は次のどれか。`ok` 以外のとき、`items` は空。
    - `ok`
    - `none`：連携していない。
    - `needs_reauth`
    - `unavailable`：Googleが失敗・タイムアウトした。
  - `items`：`{ date, preset, startsAt, endsAt }` の配列。開始日時の古い順。
    - `date`：閲覧者のタイムゾーンでの日付。
    - `preset`：`day`・`evening`・`night` のどれか。
  - ワンタップの作成は、T-03 の `POST /api/v1/availabilities` に `{ date, preset }` を送って行う。新しい作成のAPIは作らない。
- `ics-links` の `url`：`<APIのオリジン>/api/v1/ics/<token>`。
  - token は32バイトのランダム値。保存するのはハッシュだけ。
  - 期限は5分。期限内なら何度でも使える（カレンダーのアプリが2回読むことがあるため）。
- `.ics`：RFC 5545 の `VCALENDAR` に `VEVENT` を1つ入れる（中身は「振る舞い」の .ics）。
  - ヘッダー：`Content-Disposition: attachment; filename="kokohima-<meetupId>.ics"`、`Cache-Control: no-store`、`Referrer-Policy: no-referrer`。

### 例外
- **連携の開始を `POST` にする**：`GET` の画面遷移にしない。アクセストークンはメモリだけにあり、画面遷移では Bearer を送れないため。フロントは、受け取った `authorizeUrl` へ画面遷移する。
  - 作るリソースを1件で取得するAPIはないので、`Location` を付けずに200で返す。
- **コールバックは Bearer なしの `GET`**：Googleからのリダイレクトで届くため。閲覧者は `state` に結びつけた利用者で、結びつけCookieで同じブラウザかを確かめる（T-01 と同じ）。
- **.ics を、一時的な URL を発行する2段階にする**（確認事項10）。iOS のホーム画面の PWA では、`fetch` で作った Blob のダウンロードからカレンダーへの追加に進めないことがあるため。
  - 発行した URL を画面遷移で開けば、OS がカレンダーへの追加を出す。
  - トークンの期限は5分。参加者かどうかは、使うたびに確かめ直す。
- **候補の表示は、APIハンドラからGoogleを直接呼ぶ**（確認事項11）。
  - CLAUDE.md の「外部連携はoutbox経由」が対象にするのは、書き込みと通知。候補の表示は、閲覧者がその場で見る読み取りなので外れる。
  - 失敗しても5xxにしない。200の `status: unavailable` で返し、ここ暇の画面を止めない。
- **連携のトークンの交換・失効と、解除の失効も、APIハンドラから直接呼ぶ**（確認事項11）。
  - トークンをすぐに保存・削除するためで、outbox に暗号化したトークンを残さない。
  - 失効が失敗しても、保存したトークンは必ず消して204を返す（Google側の失効は試みるだけ）。
- **連携の開始の上限**：1人につき10分に10回。超えたら429 `rate_limited`（`Retry-After`）を返す。
  - KV がまだないので、`calendar_oauth_states` の行の数で数える（「連携の開始」）。
- **`.ics` の形式**：JSON でなく `text/calendar` を返す。エラーは他と同じ problem+json。
- **`AvailabilityCancelledByCalendar` の payload に時刻を入れる**（確認事項12）。T-04・T-05 の「payload は ID と `occurredAt` だけ」の例外。
  - 理由：手動の枠は行を消すので、invitation が重なりを判定するには時刻が要る。
  - 行動の情報が outbox に残るので、処理済みの行の掃除（別タスクの Cron の掃除）で消す。
- **`Idempotency-Key` は受け付けない**：T-02 の決定事項6のとおり、別タスクで扱う。連携の開始は何度やり直しても害がなく、解除は2回目が404になるだけ。

## データ
マイグレーション `apps/api/migrations/0006_calendar.sql`。日時はUnixミリ秒で持つ。

### `calendar_connections`
- `user_id`（→ users、ON DELETE CASCADE）と `provider`（`google`）。主キーは `(user_id, provider)`。
- `status`：`active`・`needs_reauth`・`disconnected` のどれか。
- `refresh_token_enc`：暗号化した更新用トークン（「トークンの暗号化」）。`active` 以外のときは NULL。
- `calendar_id`：「ここ暇」カレンダーのID。まだ作っていなければ NULL。
  - 解除・連携し直しでも消さない（「連携の状態と解除」）。
- `connected_at`、`updated_at`。
- 埋まりの記録：予定の中身は持たない。まだ確かめていなければ NULL。
  - `busy_snapshot`：前回確かめた埋まり。`[[開始, 終了], ...]` の JSON。
  - `snapshot_from`・`snapshot_to`：その範囲。
- 確認の管理：
  - `last_synced_at`：前回の確認の日時。
  - `sync_id`：確認ごとのランダムな値。
  - `sync_lease_until`：同じ人の確認を同時に2つ走らせないための期限。
- インデックス：`(status, last_synced_at)`。

### `calendar_oauth_states`
- `state_hash`（主キー）、`binding_hash`、`user_id`（→ users、CASCADE）、`provider`、`code_verifier`。
- `expires_at`（10分）、`used_at`（コールバックで使った日時）、`created_at`。
- インデックス：`(user_id, created_at)`（開始の回数の上限に使う）、`(created_at)`（掃除に使う）。

### `ics_tokens`
- `token_hash`（主キー）、`user_id`（→ users、CASCADE）、`meetup_id`（→ meetups、CASCADE）、`expires_at`（5分）、`created_at`。
- インデックス：`(created_at)`。

### 既存の表とトークン
- `outbox` は列を足さない。`processed_at` は「Queue に渡し終えた日時」として使う（「outbox を Queues に流す」）。
- アクセストークンは保存しない。使うたびに更新用トークンで取る。

### トークンの暗号化（NF-04）
- 方式：AES-256-GCM（WebCrypto）。
  - 鍵は secret `CALENDAR_TOKEN_KEYS` に置く（`{ "<kid>": "<32バイトのbase64>" }` の JSON）。
  - 暗号化に使う鍵IDは vars `CALENDAR_TOKEN_CURRENT_KID`。
- 保存の形：`v1.<kid>.<iv（12バイト、base64url）>.<暗号文（base64url）>`。
  - 復号は行の `kid` の鍵で行う。そのため、鍵を切り替えても古い行を読める。
  - 知らない `kid` の行は、一時的な失敗として扱う。設定の誤りで利用者の連携を壊さないため、`needs_reauth` にはしない。ログには `kid` だけを出す。
- 追加の認証データ（AAD）に `calendar:<provider>:<user_id>` を入れる。別の人の行に写した暗号文は復号できない。
- 実装は `apps/api/src/shared/crypto.ts` に `encryptSecret`・`decryptSecret` を足す。暗号は自作せず、WebCrypto だけを使う。

## 振る舞い

### 連携の開始
1. 上限を確かめながら、`calendar_oauth_states` に行を足す。
   - 書き方：`INSERT ... SELECT ... WHERE (閲覧者の直近10分の行の数) < 10`。使った行も数える。
   - 0行なら429。`Retry-After` は、いちばん古い行が10分を過ぎるまでの秒数。
   - 行に入れるもの：`state` と `binding` のハッシュ、`code_verifier`、閲覧者の `user_id`。
   - `state`・`binding`・PKCE の `code_verifier` は、それぞれ32バイトのランダム値。
2. 結びつけCookie `__Host-kh_cal=<binding>` を設定する。
   - 属性：HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600。
   - T-01 の `__Host-kh_oauth` とは別の名前にする。ログインと同時に進めても壊さないため。
3. `authorizeUrl` を返す。パラメータは次のとおり。
   - `scope`：上の2つ。
   - `access_type=offline`。
   - `prompt=consent`：毎回、更新用トークンを受け取るため。
   - `code_challenge_method=S256`、`state`。
   - `redirect_uri`：`/api/v1/calendar/google/callback`。
   - `include_granted_scopes` は付けない。ログインの許可と混ぜないため。

### コールバック
1. `state` のハッシュで行を取り出す。
   - 書き方：`UPDATE calendar_oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING ...`。同じ `state` は2回使えない。
   - 行がない・期限切れのときは失敗。
2. 結びつけCookieのハッシュを `binding_hash` と定数時間比較する。一致しなければ失敗。
   - これで、攻撃者が始めた連携を被害者のブラウザで完了させ、被害者の埋まりを攻撃者のアカウントにつなぐことを防ぐ。
   - 結果にかかわらず、結びつけCookieは消す。
3. `error` があれば（同意画面で断った）失敗。
4. 認可コードを、`code_verifier` とクライアントの認証情報でトークンエンドポイントに送る。
   - 応答の `scope` に2つのスコープがそろっていなければ、受け取ったトークンを失効させて失敗。
5. `calendar_connections` に書く。
   - 書き方：`INSERT ... ON CONFLICT DO UPDATE` で、更新用トークンを暗号化して書き、`status = 'active'` にする。
   - 埋まりの記録（`busy_snapshot`・`snapshot_from`・`snapshot_to`・`last_synced_at`）は NULL に戻す。
   - `calendar_id` は残す。
   - 前の行の更新用トークンは失効させない（確認事項13）。同じクライアントの許可全体が失効し、新しいトークンまで使えなくなるおそれがあるため。前のトークンは上書きして捨てる。
   - 同じ batch で、outbox に `CalendarConnected`（`{ userId, provider, occurredAt }`）を書く。
6. 成功したら `/settings/calendar?calendar=connected` へ303。失敗はすべて `?calendar=failed` へ303で、理由は区別しない。
- ログには失敗の種類だけを出す。コード・トークン・Googleの応答の本文は出さない。

### 連携の状態と解除
- 状態は、閲覧者の `calendar_connections` の行だけから作る。
- 解除では、閲覧者の `active` か `needs_reauth` の行を `disconnected` にする。
  - 書き方：`UPDATE ... SET status = 'disconnected', refresh_token_enc = NULL, busy_snapshot = NULL, ... WHERE user_id = ? AND status != 'disconnected' RETURNING refresh_token_enc`。
  - 更新用トークンが返ってきたら、復号してGoogleの revoke に送る（タイムアウト5秒、再試行なし）。
  - 0行なら404。
- 解除しても、「ここ暇」カレンダーと、すでに書いた予定はGoogleから消さない（確認事項4）。利用者のカレンダーなので、こちらからは消さない。
  - 解除の後に予定がキャンセルされても、消せない。もう一度連携すれば、`CalendarConnected` でそろえ直す（「書き込み」）。
- 解除の後に届いた予定のイベントでは、連携が `active` でないので何もしない。

### アクセストークンの取得と失効の検知
- アクセストークンは、使うたびに更新用トークンで取る。同じ処理の中では使い回す。
- トークンエンドポイントが `invalid_grant` を返したら、連携が失効したとして扱う。
  - 書き方：`WHERE status = 'active'` の条件付き UPDATE で、`status = 'needs_reauth'`、`refresh_token_enc = NULL` にする。
  - outbox に `CalendarReauthRequired`（`{ userId, provider, occurredAt }`）を書く。通知は T-07。
  - それ以外の失敗は一時的な失敗として扱い、再試行する。
- `active` でない人については、候補・確認・書き込みのどれでもGoogleを呼ばない。

### カレンダーの空き（候補）
1. 連携が `active` でなければ、`status` を `none` か `needs_reauth` にして、空で返す。
2. availability の application で候補の枠を作る。
   - `from`〜`to` を閲覧者のタイムゾーンの日付に分け、日付ごとに閲覧者の今のプリセット（昼・夕方・夜）の枠を作る（T-03 と同じ変換）。
   - 開始が現在以前の枠と、開始が60日より先の枠は外す。T-03 では作れないため。
3. 埋まりを取る。
   - 呼び方：Googleの freeBusy.query で、`items` は `primary` だけ。
   - 範囲は、作った枠の最初の開始〜最後の終了。範囲の端にかかる枠も確かめるため。
   - HTTP の失敗、5秒のタイムアウト、応答の `calendars.primary` がない、`calendars.primary.errors` がある場合は、すべて `unavailable`。
4. 埋まりと1分以上重なる枠を外す。
5. 自分のここ暇（手動の枠とくり返しの展開）と1分以上重なる枠を外す。
   - 手動の枠と重なる枠は、作っても T-03 で409になる。
   - くり返しと重なる枠は作れるが、同じ時間の重複なので出さない。
6. 埋まりは保存しない。記録を書くのは「定期の確認」だけ。

### 定期の確認と自動取り消し（確認事項5・6）

#### 確認の割り当て
- Cron（15分ごと）で、`status = 'active'` で `last_synced_at` が10分以上前（または NULL）の連携を選ぶ。
  - 古い順に最大200件。
  - 1人ずつ Queue に `calendar_sync` のメッセージ（`{ userId, provider }`）を送る。`sendBatch` は100件ずつ。
  - outbox には書かない。状態の変化ではないため。
- `scheduled` は `event.cron` で処理を振り分ける。

#### consumer の手順
1. 確認の権利を取る。
   - 書き方：`UPDATE calendar_connections SET sync_lease_until = now + 5分 WHERE user_id = ? AND provider = ? AND status = 'active' AND (sync_lease_until IS NULL OR sync_lease_until < now) RETURNING ...`。
   - 0行なら何もしない。
2. 範囲 `[now, now + 60日)` の埋まりを、freeBusy.query（`primary`）で取る。60日にするのは、ここ暇を作れるのが60日先までのため（T-03）。
   - 候補と同じ条件で失敗を判定する（HTTP の失敗、タイムアウト、`primary` がない、`errors` がある）。
   - 失敗したら記録を更新せず、何も取り消さず、権利を戻す（`sync_lease_until = NULL`）。再試行は Queue に任せる。
   - エラー付きの200を「埋まりなし」と扱うと、次の確認で埋まりがすべて「新しく入った」ことになるので、この判定が要る。
3. 前回の記録がなければ（連携した直後）、記録だけを書いて終わる。連携した時点で入っている予定では、ここ暇を取り消さない。
4. 新しく入った埋まりを求める。
   - 定義：今回の埋まりから前回の埋まりを引き、前回の範囲 `[snapshot_from, snapshot_to)` に入る部分だけを残したもの。
   - 範囲がずれて新しく見えるようになった先の日付は、新しく入ったものとして扱わない。
   - この計算は calendar/domain の純粋な関数で行う。
5. 取り消すここ暇を選ぶ（availability の application の関数）。次の3つをすべて満たすもの。
   - 終了が現在より後。
   - 前回の確認より前に作った。手動の枠は `created_at < last_synced_at`、くり返しはルールの `created_at < last_synced_at`。
     - これは、前回の確認の後に入った予定を見たうえで、重なるここ暇を作った場合に取り消さないため（確認事項6）。
   - 新しく入った埋まりと1分以上重なる。
6. 取り消す枠が20を超えたら、異常として扱う。
   - 何も取り消さず、記録だけを書き直す。ログには数だけを出す。
   - Google側の一時的な不具合で、60日分のここ暇が一度に消えるのを防ぐため。
7. 1つの batch で書く。
   1. 記録を更新する。
      - 書き方：`UPDATE calendar_connections SET busy_snapshot = ?, snapshot_from = ?, snapshot_to = ?, last_synced_at = ?, sync_id = <新しいランダム値>, sync_lease_until = NULL WHERE user_id = ? AND provider = ? AND status = 'active' AND sync_lease_until = <1で書いた値>`。
      - 確認の途中で解除・連携し直し・権利切れがあれば、0行になる。
   2. 取り消しの文を書く。availability の infra の関数が作り、どの文にも `EXISTS (SELECT 1 FROM calendar_connections WHERE user_id = ? AND provider = ? AND sync_id = <新しい値>)` を付ける。1が0行なら、どの文も何もしない（T-04 の `transition_id` と同じ書き方）。
      - 手動の枠：行を削除する（T-03 の取り消しと同じ）。
      - くり返しの展開：その日を例外に足す（`recurrence_exceptions` に `INSERT OR IGNORE`。T-03 の「この日だけ外す」と同じ）。
   3. 取り消しがあれば、outbox に `AvailabilityCancelledByCalendar` を書く（同じ `EXISTS` 付き）。
- ここ暇を作るときは、埋まりと重なっていても止めない。予定を知ったうえで作ることもあるため。ただし候補には出さない。
- 一時的な失敗は Queue の再試行に任せる。権利の期限（5分）が切れれば、次の確認で取り直せる。

### 未返答の誘いの自動の「今回は難しい」
- `AvailabilityCancelledByCalendar` の payload は `{ userId, ranges: [{ startsAt, endsAt }], occurredAt }`。
  - `ranges` は取り消した枠の時刻だけ。
  - 1回の確認で取り消した枠をまとめて、1つのイベントにする（NF-07）。
- invitation の consumer は、次の条件をすべて満たす誘いを `declined` にする。
  - 条件：受信者が `userId`、`status = 'pending'`、返事の期限前、時間が `ranges` のどれかと1分以上重なる。
  - 遷移は、手で「今回は難しい」を押したときと同じ（T-04 の `respondInvite` の decline）。outbox の `DirectInviteDeclined` も同じ形。
- 送信者に返す誘いの形・項目・時刻の扱いは、手で断ったときと同じにする。自動で断ったことを区別させず、理由は保存も送信もしない。
- 次のものは変えない（確認事項7）。
  - `counter_proposed`（受信者が代わりの時間を出し、送信者の判断を待っている誘い）。
  - 募集への応答。
- 条件付き UPDATE なので、同じイベントが2回届いても、2回目は何もしない。

### 成立した予定のGoogleカレンダーへの書き込み（確認事項8）

#### 対象とそろえ方
- consumer は、次のイベントを受け取ったら、対象の予定ごとに「あるべき状態」にそろえる。同じイベントが何度届いても、結果は同じになる。
  - `MeetupConfirmed`・`MeetupCancelled`・`MeetupLeft`：payload の予定が対象。
  - `CalendarConnected`：その人が参加者（抜けた人を含む）で、終了が現在より後の予定が対象。
    - 100件ずつ処理し、続きは Queue に送り直す。
    - 解除していた間のキャンセル・抜けも、ここで消す。
- 予定ごとの手順：参加者（抜けた人を含む。`CalendarConnected` ではその人だけ）のうち、連携が `active` の人について、書くべきなら書き、書くべきでなければ消す。
  - 書くべき予定：`confirmed`、その人が抜けていない、終了が現在より後。
- 書いた後、予定と参加者の状態を読み直す。書くべきでなくなっていたら、消す。
  - Queues は順番を守らず、同時にも届く。`MeetupConfirmed` の処理が書いている間に `MeetupCancelled` の処理が削除を終えると、予定が残ってしまう。読み直しはこれを防ぐため。

#### 「ここ暇」カレンダー
- `calendar_id` がなければ、カレンダーを作る（名前「ここ暇」、タイムゾーンは `users.timezone`）。
  - `calendar_id` は、`WHERE calendar_id IS NULL` の条件付き UPDATE で書く。
  - 0行なら（同時に別の処理が作った）、作ったカレンダーを消して、保存されている方を使う。
- `calendar_id` があっても、使えないことがある。
  - 例：利用者が消した、連携し直した Google アカウントが前と違う。
  - 予定の書き込みが404・403なら、`calendar_id` を NULL に戻してカレンダーを作り直す。その人のこれからの予定は、`CalendarConnected` と同じ処理で書き直す。

#### 予定のID
- 予定のIDは、予定のIDから決まる値にする：`kh` ＋ UUID のハイフンを除いた16進。Googleの予定IDに使える文字（base32hex の0-9a-v）に収まる。
- 作成が「すでにある」で失敗したら、更新する。削除済みの予定も、更新で `status: confirmed` に戻す。
- 削除が404・410なら、成功として扱う。

#### 書く内容
- タイトル：「ここ暇：<自分以外の参加者の表示名>」。
  - 表示名は「、」でつなぐ。抜けた人は除く。
  - 表示名がない人は「名前未設定の友達」（T-02 と同じ）。
- 開始・終了。
- 場所：エリア（なければ空）。
- 説明：アプリの予定の詳細の URL（`APP_ORIGIN/meetups/<id>`）と、誘いのリンク（あれば）。
- ひとことは書かない（確認事項8）。
- 参加者が抜けたら、残った参加者の予定もタイトルを書き直す。
- 再試行の単位は、人ごとではなく1つのイベントごと。途中まで書けていても、そろえ直すので二重にならない。

### outbox を Queues に流す
- Cron（1分ごと）で、次の手順で流す。送ってから処理済みにする。
  1. `processed_at IS NULL` で、`type` がこの仕様書で処理する型の行を、作成日時の古い順に最大100件読む。
     - 処理する型：`MeetupConfirmed`・`MeetupCancelled`・`MeetupLeft`・`CalendarConnected`・`AvailabilityCancelledByCalendar`。
  2. Queue に `sendBatch` する。
  3. 送れたら `UPDATE outbox SET processed_at = ? WHERE processed_at IS NULL AND id IN (SELECT value FROM json_each(?))` で処理済みにする。ID の一覧は JSON の配列1つで渡す（D1 の値100個の制限のため）。
- 途中で止まっても、行は未処理のまま残る。次の実行で送り直すので、イベントは消えない（少なくとも1回は届く）。
  - 二重に届くことは、consumer の冪等性で受ける（どの処理も条件付き更新か、あるべき状態にそろえる処理）。
- ほかの型の行（`DirectInviteSent`・`FriendshipEstablished` などの通知の対象）は取り出さず、未処理のまま残す。T-07 で型を足して流す。
- 同じ Cron で、期限を10分過ぎた `calendar_oauth_states` と、期限を過ぎた `ics_tokens` を消す。
- Queue のメッセージは `{ kind: "outbox", id, type, payload }` か `{ kind: "calendar_sync", userId, provider }`。consumer は `kind` と `type` で処理を振り分ける。
- 再試行は最大5回で、間隔を広げていく。それでも失敗したら退避キューに送る。
  - 退避キューのメッセージは処理しない。ログには `kind`・`type`・`id` だけを出す。
- ログには、payload の中身（ID以外）、トークン、Googleの応答の本文を出さない。

### .ics
- リンクの発行（`ics-links`）：閲覧者が予定の参加者で、抜けていないときだけ発行する。
  - 判定の SQL は、`findMeetupFor` と同じ条件に `left_at IS NULL` を足したもの。
  - それ以外は404。予定がない・参加者でない・抜けたを区別しない。
  - 抜けた人に出さないのは、抜けた後は予定の参加者の名前を見せないため（T-05）。
  - 抜けた人が前に取り込んだ予定は、こちらからは消せない。Googleに連携していれば、Google側からは消える。
- 取得（`/ics/{token}`）：トークンのハッシュで、期限内の行を読む。読むたびに、上と同じ SQL の条件で参加者かを確かめ直す。どちらかが外れたら404。
- 予定の状態：`confirmed` は `STATUS:CONFIRMED`、`cancelled` は `STATUS:CANCELLED`。同じ `UID` なので、取り込み済みの人のカレンダーで消せる。
- 中身：
  - `UID:<meetupId>@kokohima`、`DTSTAMP`。
  - `DTSTART`・`DTEND`：UTC。
  - `SUMMARY`・`LOCATION`・`DESCRIPTION`：Googleに書く内容と同じ。
  - `SEQUENCE`：状態が変わるたびに増える値。キャンセル済みなら1、それ以外は0。
- 文字列は RFC 5545 のとおりエスケープする（`\`・`;`・`,`・改行）。行は75オクテットで折り返す。
  - 利用者が入れた文字列で、別のプロパティや `VEVENT` を作れないことをテストする。

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）

#### 設定のカレンダー連携（`/settings/calendar`）
- 友達タブの「アカウント」節からリンクする。
- Google の状態を「連携していません」「連携中」「もう一度連携してください」のどれかで出す。ボタンは「Googleカレンダーと連携」と「連携をやめる」。
- 「連携」を押すと `POST /authorizations` を呼び、`authorizeUrl` へ画面遷移する。
- 戻ってきたときの表示は静かにする（赤を使わない）。
  - `?calendar=connected`：「連携しました」。
  - `?calendar=failed`：「連携できませんでした。もう一度お試しください」。
- 読むのは空き／埋まりだけで、予定の中身は読まないことを1文で書く。
- Apple：「Appleカレンダーは準備中です。成立した予定は .ics で追加できます」。

#### ここ暇タブの「カレンダーの空き」
- 連携している人にだけ出す。
- 今日から7日分の候補を「6/1（土）夜 19:00〜23:00」の形で並べ、押すとここ暇になる。
  - 楽観的更新はしない。成功したら、自分の一覧と候補を読み直す。
- `unavailable` は「カレンダーを読み込めませんでした」。`needs_reauth` は設定へのリンクを静かに出す。

#### 予定の詳細
- 「カレンダーに追加（.ics）」のボタンを置く。
- 押すと `ics-links` を呼び、返った `url` へ画面遷移する。iOS では OS のカレンダーへの追加が開き、ほかではダウンロードになる。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `CALENDAR_TOKEN_KEYS` | secret | トークンの暗号化の鍵（kid → 32バイトのbase64 の JSON） |
| `CALENDAR_TOKEN_CURRENT_KID` | vars | 暗号化に使う鍵ID |
| `JOBS` | Queue（producer・consumer） | outbox と確認のメッセージ。退避キュー付き |
| Cron | triggers | `* * * * *`（outbox と掃除）、`*/15 * * * *`（確認の割り当て） |

- `GOOGLE_CLIENT_ID`・`GOOGLE_CLIENT_SECRET` は T-01 のものを使う。リダイレクト先 `/api/v1/calendar/google/callback` を Google Cloud のクライアントに登録する（人が行う）。
- Queue は `infra/terraform` に足す（本体と退避キュー、staging・prod）。
  - wrangler の各環境（ローカル・e2e・staging・prod）に、バインディングと Cron を書く。
  - `infra-change` スキルに従い、apply・deploy はしない。
- 本番のエントリ（`src/index.ts`）と E2E のエントリは、どちらも `fetch`・`scheduled`・`queue` を export する。
- E2E とローカルの `CALENDAR_TOKEN_KEYS` は、`scripts/write-e2e-dev-vars.mjs` で作る。`CALENDAR_TOKEN_CURRENT_KID` は `env.e2e` の vars に置く。

### E2E用の偽のGoogle
- E2E では本物のGoogleを呼ばない。
  - E2E のエントリ（`src/e2e/entry.ts`）で、`AppDeps` の `google.endpoints` を偽の経路に向ける。認可の画面遷移の URL もこれに含める。
  - 偽の実装は `src/e2e/` に置き、本番のエントリから import しない。
- 偽の経路：
  - 偽の認可画面 `/__e2e__/calendar/google/authorize`：同意したことにして、コールバックへリダイレクトする。
  - 偽のトークン・freeBusy・カレンダー・予定の経路。
  - 偽の埋まりを設定する `/__e2e__/calendar/busy`。
  - すぐに処理する経路：確認を実行する `/__e2e__/calendar/sync`、outbox を処理する `/__e2e__/outbox/drain`。
  - どれも `E2E_MODE=1` のときだけ有効。
- 偽の実装の状態は、E2E のエントリだけが作る表に置く。本番のマイグレーションには入れない。
- CI の本番ビルドの検査（`__e2e__|e2eLogin|e2eExpireBroadcast`）に、新しい関数名（`e2eCalendar`・`e2eOutbox`）を足す。

## 認可と秘匿

### 閲覧者IDの使い方
- すべてのAPIで、閲覧者は `requireAuth` か `requireActiveSession` から取る。コールバックでは `state` に結びつけた利用者、`/ics/{token}` ではトークンに結びつけた利用者。
- パスや本文の利用者IDは使わない。
- 連携・候補・解除では、閲覧者自身の `calendar_connections` の行だけを SQL の条件で読む。

### 他人のデータに届かないことの保証
- 連携の行は、`user_id = 閲覧者` の条件でだけ読み書きする。
- 候補は、閲覧者のトークンでだけGoogleを呼ぶ。
- .ics のリンクの発行と取得では、閲覧者（トークンの利用者）が抜けていない参加者である予定だけを、SQL の条件で読む。
- 別の人の暗号文を写しても、AAD が違うので復号できない。
- consumer は payload の `userId`・`meetupId` を使う。ただし書き込みの対象は、SQL で読んだ参加者と、その人の連携だけ。

### 予定の中身
- Googleから読むのは、freeBusy.query の `primary` の埋まり（開始・終了）だけ。
- 予定の一覧・取得、カレンダーの一覧のAPIは呼ばない。スコープでも呼べない。
- 保存するのも埋まりの時刻だけ。

### 区別させない応答
- 自動の「今回は難しい」は、送信者への応答とイベントが、手で断ったときと同じ。
- 友達には、閲覧者が連携しているかどうかも、ここ暇が自動で取り消されたかどうかも返さない。友達から見えるのは、ここ暇が消えたことだけで、手で取り消したときと同じ。
- コールバックの失敗は、すべて同じ `?calendar=failed`。
- .ics の404は、予定がない・参加者でない・抜けた・トークンの期限切れを区別しない。

### トークン
- 更新用トークンは暗号化して保存する。アクセストークンは保存しない。
- ログ・エラー・problem+json の `detail` に出さない。ブラウザにも渡さない。
- .ics のトークンはハッシュだけを保存する。期限は5分で、URL に入るので `Referrer-Policy: no-referrer` を付ける。

## テスト計画

### 単体テスト（実装PRで必須）

#### 暗号化
- [ ] 往復できる。
- [ ] 古い鍵の行を、鍵IDで復号できる。
- [ ] 知らない鍵IDは一時的な失敗になる。
- [ ] AAD が違うと失敗する。
- [ ] 改ざんすると失敗する。
- [ ] 毎回 IV が違う。

#### 連携の開始
- [ ] `authorizeUrl` のパラメータ：スコープ2つ、`access_type=offline`、`prompt=consent`、S256、`include_granted_scopes` なし。
- [ ] 結びつけCookie。
- [ ] 10分に10回で429になる。`Retry-After` の値。
- [ ] 同時に送っても上限を超えない。
- [ ] 失効したセッションでは401。

#### コールバック
- [ ] 成功すると、暗号化した行と `CalendarConnected` が書かれる。
- [ ] 次の場合はすべて同じ `failed` になる：`state` の使い回し、期限切れ、別のブラウザ（Cookie がない・違う）、`error`、スコープ不足（失効を呼ぶ）。
- [ ] 連携し直すと、`calendar_id` が残り、埋まりの記録が NULL に戻る。

#### 状態と解除
- [ ] 状態：`none`・`connected`・`needs_reauth`、`disconnected` は `none`。他人の連携が見えない。
- [ ] 解除すると、`disconnected` になり、トークンと記録が消え、revoke を呼ぶ。
- [ ] revoke が失敗・タイムアウトしても、204になりトークンが消える。
- [ ] 連携していなければ404。
- [ ] 他人の連携を消せない。

#### 候補
- [ ] プリセットの枠ができる。
- [ ] 次の枠は外れる：埋まりと重なる、過去、60日より先、手動の枠・くり返しと重なる。
- [ ] タイムゾーンで日付を分ける。
- [ ] freeBusy の範囲が、枠の最初の開始〜最後の終了になる。
- [ ] 次の場合は `unavailable`：HTTP の失敗、タイムアウト、エラー付きの200、`primary` がない。
- [ ] `none`・`needs_reauth` を返す。
- [ ] 14日を超える範囲は400。

#### 新しい埋まりの判定（domain）
- [ ] 初回は取り消さない。
- [ ] 前回にない埋まりだけを新しいとする。
- [ ] 前回の範囲の外は除く。
- [ ] 埋まりが広がった・つながった・消えた場合。
- [ ] 1分の重なりの境目。

#### 自動取り消し
- [ ] 手動の枠を削除し、くり返しの例外を足す。
- [ ] 終わった枠は対象外。
- [ ] 前回の確認の後に作った枠・ルールは取り消さない。
- [ ] `AvailabilityCancelledByCalendar` を1つにまとめる。
- [ ] 取り消しが20を超えたら、何も取り消さずに記録を書き直す。
- [ ] freeBusy がエラー付きの200を返したら、記録を更新せず、何も取り消さない。
- [ ] 権利が取れないときは何もしない。
- [ ] 確認の途中で解除・連携し直し・権利切れがあると、batch のどの文も書かない。
- [ ] 友達から見える応答（みんな・友達の詳細）が、手で取り消したときと同じ。

#### 自動の「今回は難しい」
- [ ] 重なる `pending` だけが `declined` になり、`DirectInviteDeclined` が書かれる。
- [ ] 次の誘いは変わらない：`counter_proposed`、期限切れ、別の人宛て、重ならないもの。
- [ ] 2回届いても1回だけ処理する。
- [ ] 送信者への応答が、手で断ったときと同じ。

#### 失効の検知
- [ ] `invalid_grant` で `needs_reauth` になり、`CalendarReauthRequired` が書かれる。その後はGoogleを呼ばない。

#### 書き込み
- [ ] 成立したら、連携している参加者だけに書く。
- [ ] キャンセルで消す。
- [ ] 抜けた人の予定を消し、残りの人のタイトルを直す。
- [ ] 2回届いても同じ結果になる。
- [ ] 「すでにある」は更新になる（削除済みも戻る）。
- [ ] 404・410の削除は成功として扱う。
- [ ] 解除した人には何もしない。
- [ ] 同じ予定の確定とキャンセルが同時に届いても、カレンダーに予定が残らない（書いた後の読み直し）。
- [ ] 「ここ暇」カレンダーについて：
  - [ ] なければ作る。
  - [ ] 同時に作ったら片方を消す。
  - [ ] 404・403なら作り直して、これからの予定を書き直す。
- [ ] `CalendarConnected` で、これからの予定を書き、解除中にキャンセルされた予定を消す。
- [ ] ひとことを書かない。
- [ ] 予定のIDが base32hex に収まる。

#### Googleへのリクエスト
- [ ] 送る先は、許可した経路だけ：トークン、revoke、freeBusy（`items` は `primary` だけ）、カレンダーの作成・取得・削除、予定の作成・更新・削除。
- [ ] 予定の一覧・取得、カレンダーの一覧を呼ばない。
- [ ] `busy_snapshot` に時刻以外が入らない。

#### outbox の取り出し
- [ ] 処理する型だけを、最大100件取り出す。
- [ ] ほかの型は未処理のまま残る。
- [ ] 送れなければ未処理のまま残る。
- [ ] 処理済みにする SQL が、値100個の制限に収まる。
- [ ] 期限切れの `calendar_oauth_states`・`ics_tokens` を掃除する。

#### .ics
- [ ] 参加者はリンクを発行して取得できる。
- [ ] 次の場合は同じ404：参加者でない、抜けた、存在しない、トークンの期限切れ、発行後に抜けた。
- [ ] キャンセル済みは `STATUS:CANCELLED`。
- [ ] エスケープと折り返し：改行・`;`・`,` を入れても `VEVENT` が1つ。

#### ログ
- [ ] トークン・コード・Googleの応答の本文・payload の中身が出ない。

#### Web
- [ ] 設定の状態の表示と、連携・解除。
- [ ] `?calendar=` の表示。
- [ ] 候補のワンタップでここ暇を作る。
- [ ] `unavailable` の表示。
- [ ] .ics のリンクへの画面遷移。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 連携：設定で「Googleカレンダーと連携」→ 偽の認可画面 → 「連携中」になる → 「連携をやめる」で「連携していません」に戻る。
- [ ] 候補：連携した人のここ暇タブに候補が出て、押すとここ暇になる。偽の埋まりと重なる時間帯は出ない。
- [ ] 自動取り消し：
  1. A が連携し、確認を実行する（最初の確認は記録だけ）。
  2. A がここ暇を作り、確認をもう一度実行する（作った枠を「前回の確認より前」にするため）。
  3. B が A を誘う。
  4. 偽の埋まりを足して確認を実行し、outbox を処理する。
  5. A のここ暇が消え、B の誘いが「今回は難しい」になる。
- [ ] .ics：成立した予定の詳細から .ics のリンクを開くと、中身に予定の時刻がある。

## スコープ外
- Apple CalDAV（T-09。NF-10 の技術検証を先に行う）、Outlook。
- 通知（T-07）。`AvailabilityCancelledByCalendar`・`CalendarReauthRequired` の本人への通知と、ほかの型の outbox の行の処理を含む。
- Googleの変更通知（Webhook）（確認事項5）。`calendar.freebusy` のスコープでは予定の変更を見張れない（見張るには予定を読むスコープが要る）ため、定期の確認で代える。
- メインのカレンダー以外の埋まり（確認事項2）。
- 誘い・募集を作る画面での空きの表示。
- 候補の取得のキャッシュと、利用者ごとの上限。KV とあわせて別タスクで扱う。今は、開くたびにGoogleを1回呼ぶ。
- `Idempotency-Key`、KV でのレート制限（別タスク）。
- 処理済みの outbox の行の掃除（別タスクの Cron の掃除）。
- 監査ログ（カレンダー連携の記録。別タスク）。
- Googleの審査（一般公開まで）。テスト中の公開状態では、更新用トークンが7日で失効することがある。その場合は `needs_reauth` になる。
- 最終的な画面デザイン。

## 確認事項（合意前に解消する）
利用者に事前に確かめずに、提案として書いた。PRのレビューで合意したら「決定事項」にする。

1. Googleのスコープは `calendar.freebusy` と `calendar.app.created` の2つにする。どちらかが外されたら連携しない。予定は、利用者のカレンダーではなく、アプリが作る「ここ暇」カレンダーに書く。
2. 埋まりはメインのカレンダーだけで確かめる。カレンダーの一覧を読むスコープは取らない。
3. Googleのアカウントのメールアドレス・名前は、取らないし保存もしない。設定には「連携中」だけを出す。
4. 解除しても、書いた予定と「ここ暇」カレンダーは消さない。解除中の変更は、もう一度連携したときにそろえる。
5. 自動取り消しは、Webhook でなく15分ごとの確認で行う。確かめるのは60日先まで。
6. 取り消すのは、次の3つをすべて満たすここ暇だけにする。前回の埋まりは時刻だけ保存する。
   - 連携後に新しく入った埋まりと1分以上重なる。
   - 前回の確認より前に作った。
   - 1回の確認で取り消す数が20以下。
7. 自動で「今回は難しい」にするのは `pending` の誘いだけ。`counter_proposed` と募集の応答は変えない。範囲は、要求定義書の「その枠への」のとおり、取り消した枠と重なる誘い（新しく入った埋まりと重なる誘いではない）。
8. Googleに書く内容は、タイトル（「ここ暇：相手の名前」）・時刻・エリア・アプリへのリンク・誘いのリンク。ひとことは書かない。
9. このタスクはGoogleだけにする。Apple CalDAV は、NF-10 の技術検証とあわせて T-09 にする。それまで、Apple の人と連携しない人には .ics を出す。
10. .ics は、5分の一時的な URL を発行してから開く2段階にする（iOS の PWA で、カレンダーへの追加につなげるため）。
11. 次の処理は、CLAUDE.md の「外部連携はoutbox経由」の例外として、APIハンドラからGoogleを直接呼ぶ。
    - 候補の表示（読むだけ）。
    - 連携のトークンの交換・スコープ不足のときの失効。
    - 解除の失効。
12. `AvailabilityCancelledByCalendar` の payload に、取り消した枠の時刻を入れる（payload は ID だけ、の例外）。
13. 連携し直したとき、前の更新用トークンは失効させずに捨てる。revoke が新しいトークンまで失効させるおそれがあるため。実装の最初に公式で確かめる。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-25 | 初版 | |
