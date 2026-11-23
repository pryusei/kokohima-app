# T-28 仕様書：LINE連携（招待リンクをLINEで送る・お知らせをLINEで受け取る）

- 状態：下書き
- タスク票：docs/tasks/T-28-line.md
- 関係する要件：F-08、F-16、NF-02、NF-07、要求定義書「リスクと対策」（友達が使わない・iOSのWebプッシュが届かない・LINEで足りると言われる）、セキュリティ設計（外に出ている窓口の一覧、ログに個人情報を出さない）

## 概要
LINEと張り合わず、LINEを入口に使う。2つのことをする。
1. **LINEで送る**：招待リンクを作ったシートから、LINEのトークにそのまま送る。開いた友達が、Googleのログインを断られるLINEのアプリ内ブラウザでなく、外のブラウザで開くようにする。
2. **LINEで受け取る**：お知らせの合図を、ここ暇のLINE公式アカウントから送る。合図は T-07 のプッシュと同じく中身を持たず（「新しいお知らせがあります」とお知らせ一覧へのURLだけ）、相手の名前や誘いの内容はLINEに渡さない。

## 決めたこと
（合意前の案。確認事項で利用者に確かめる）
1. **LINEはログインの手段にしない。** F-01 は変えない。LINEログイン（OAuth）は、通知の宛先としてLINEの利用者IDを受け取るためだけに使う（カレンダーの連携と同じく、ログインとは分ける）。
2. **合図に中身を入れない。** 本文は固定の文と、お知らせ一覧へのURLだけ（T-07 決定事項2と同じ考え方）。LINE（LINEヤフー）に渡るのは、LINEの利用者ID・合図を送った時刻・固定の文だけ。
3. **LINEが使える人には、LINEだけで送る。** 連携していて公式アカウントを友だち追加している人には、プッシュもメールも送らない（同じ合図が2つ届かないように）。LINEで送れなかったとき（ブロック・上限・LINE側の失敗）は、今の T-07 の届け方（プッシュ → メール）に戻す。
4. **未読の合図があればまとめる。** 前にLINEで知らせたお知らせがまだ未読なら、次のお知らせではLINEを送らない。合図に中身がないので、未読が1つでもあれば「お知らせがある」は伝わっている。LINEの通数（料金）を抑えるため。
5. **新端末のログインは今のとおりメールだけ。** LINEのアカウントを他人が使っている場合に、乗っ取りの知らせが乗っ取った側に届かないように。
6. **Webhookは友だち追加（`follow`）とブロック（`unfollow`）だけを扱う。** 利用者がトークに書いたメッセージなど、ほかのイベントは保存もログもしない。公式アカウントの自動の応答は、LINE Official Account Manager で切る（人が行う）。
7. **連携していない人のLINEの利用者IDは持たない。** 連携していない人が友だち追加しても、何も書かない。
8. **LINEで送るボタンは、LINEのAPIを呼ばない。** `https://line.me/R/share?text=...` を開くだけ。今の「URLをコピー」「共有」（Web Share API）は残す。

## LINE側の準備（人が行う）
- LINE Developers で、プロバイダを1つ作り、その中に次の2つのチャネルを作る。LINEの利用者IDはプロバイダごとに違うので、同じプロバイダにすること。
  - Messaging API チャネル（＝LINE公式アカウント「ここ暇」）
  - LINEログインのチャネル。「リンクされたLINE公式アカウント」に上の公式アカウントを設定する（`bot_prompt` で友だち追加をすすめるため）。コールバックURLに `${API_ORIGIN}/api/v1/line/callback` を登録する。
- 公式アカウントの設定：応答メッセージ・あいさつメッセージを切る（または「お知らせはアプリで読めます」の固定の文にする）。チャットは切る。Webhookを有効にし、URLに `${API_ORIGIN}/api/v1/line/webhook` を設定する。
- 料金プラン：仕様書を書いた時点の理解では、無料のプランは1か月200通まで。実装PRで公式の今の料金と通数の数え方を確かめ、`LINE_MONTHLY_LIMIT` をその値より少し下にする（確認事項1）。
- staging・prod で別のプロバイダ（またはチャネル）にする。ローカル・E2E は偽の実装を使い、本物のLINEを呼ばない。

## LINEで送る（招待リンク）

### 画面
- 招待リンクの発行のシート（T-02「招待リンクの発行」・T-11）で、URLを作ったあとの「URLをコピー」「共有」の並びに「LINEで送る」を足す。
- 押すと、新しいタブ（`target="_blank"`、`rel="noopener noreferrer"`）で次を開く。
  - `https://line.me/R/share?text=<encodeURIComponent(本文)>`
  - 本文：`ここ暇で友達になろう\n<LINE用の招待リンク>`
  - 名前・ひとことは入れない（送る本人がトークで書ける）。
- LINE用の招待リンク：API の応答の `url`（`${APP_ORIGIN}/invite#t=<トークン>`）の、`#` の前に `?openExternalBrowser=1` を入れたもの（`${APP_ORIGIN}/invite?openExternalBrowser=1#t=<トークン>`）。フロントで作る。API の `url` の形は変えない。
  - `openExternalBrowser=1` は、LINEのアプリ内ブラウザで開いたURLを外のブラウザで開き直させるLINEの決まり。Googleは埋め込みのブラウザでのログインを断るので（`disallowed_useragent`）、LINEの中で開くとログインできない。
  - 外のブラウザで開き直したときにフラグメント（`#t=`）が残るかは、iOS・Androidの実機で確かめる（確認事項3）。残らなければ、この節を見直す。
- 受け口（`/invite`）は、`openExternalBrowser` のクエリを読まず、消しもしない（トークンを `history.replaceState` で消すときに、クエリも一緒に消してよい）。
- 色・部品は T-11 のトークンと `apps/web/src/ui/` のものを使う。LINEのロゴや緑色は使わない（LINEのブランドの使い方の決まりに沿わせる手間を省くため。文字だけのボタン）。

### 外に渡すもの
- LINEで送るを押すと、招待リンク（トークンを含む）が `line.me` のURLのクエリに入る。フラグメントでないので、LINEの側に残る。本人がLINEで送ると選んだものなので受け入れる。リンクの期限・人数上限・無効化（T-02）で担保する。
- LINEのトークに貼られたURLは、LINEがプレビューのために取りに来る。フラグメントはサーバーに送られないので、トークンは渡らない。画面の `index.html` の OGP（T-12）は誰が開いても同じで、発行者の名前は出ない（今のまま）。

## LINEで受け取る（API）
`api-conventions` に従う。例外は下の「例外」に書く。スキーマは `packages/shared/src/schemas/line.ts`。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/me/line-link/start` | Bearer（`requireActiveSession`）＋Origin | なし | 200：`{ authorizeUrl }` | 401、409 `invalid_state`（LINEの設定値がない）、429 `rate_limited` |
| GET | `/api/v1/line/callback` | なし（`state` と結びつけCookie） | query：`code`、`state`（または `error`） | 303：`/settings/notifications?line=linked` か `?line=failed` | （常に303） |
| GET | `/api/v1/me/line-link` | Bearer | なし | 200：`lineLinkSchema` | 401 |
| DELETE | `/api/v1/me/line-link` | Bearer（`requireActiveSession`）＋Origin | なし | 204（連携していなくても204） | 401 |
| POST | `/api/v1/line/webhook` | なし（`x-line-signature` の署名） | 本文：LINEのWebhookの JSON（64KiB まで） | 200（本文なし） | 401（署名がない・合わない。本文なし） |

### 入力・出力
- `lineLinkSchema`：`{ available, status, linkedAt, addFriendUrl }`（strict）
  - `available`：LINEの設定値がそろっているか（「設定値」）。`false` なら `status` は `none`。
  - `status`：`none`（連携していない）・`needs_friend`（連携したが、公式アカウントを友だち追加していない、またはブロックしている）・`linked`（LINEで受け取れる）。
  - `linkedAt`：連携した日時（ISO 8601）。`none` のときは `null`。
  - `addFriendUrl`：vars の `LINE_ADD_FRIEND_URL`（`https://line.me/R/ti/p/@...`）。`needs_friend` のときだけ入れ、ほかは `null`。
- Webhook の本文は、`destination` と `events[]` だけを見る。`events[].type` が `follow`・`unfollow` で、`source.type` が `user` のものだけを扱う（決定事項6）。形が違うものは読み飛ばして200（LINEに再送させない）。

### 例外
- **連携の開始を `POST` にする**、**コールバックは Bearer なしの `GET`**：T-06 と同じ理由（アクセストークンはメモリだけで、画面遷移では送れない。LINEからのリダイレクトで届く）。
- **コールバックで LINE を直接呼ぶ**：トークンの交換と ID トークンの検証、友だちかどうかの確認、アクセストークンの失効は、APIハンドラから直接呼ぶ（T-06 決定事項11 と同じ。LINEのアクセストークンを outbox にも D1 にも残さないため）。要求定義書の「API が外部を呼ぶのは〜だけ」に、LINE連携のときのトークン交換を足す（実装PR）。
- **Webhook は APIハンドラで D1 を書く**：書くのは自分の表の1列だけで、外部は呼ばない。LINEは応答が遅いと再送するので、Queue を通さない。
- **Webhook のエラーの形**：LINEに向けた応答なので、problem+json にせず、本文なしの200・401にする。
- **解除は連携がなくても204**：T-07 の購読の解除と同じ考え方。

## データ
マイグレーション `apps/api/migrations/00xx_line.sql`（番号は実装のときの次の番号）。日時はUnixミリ秒。コンテキストは `notification`（`apps/api/src/notification/{domain,application,infra}`）。

### `line_links`
- 列
  - `user_id`（PK、→ users、CASCADE）
  - `line_user_id_enc`（LINEの利用者ID。T-06 の `encryptSecret`。鍵は T-07 の `NOTIFICATION_KEYS`・`NOTIFICATION_CURRENT_KID`、AAD は `line:<user_id>`）
  - `line_user_id_hash`（LINEの利用者IDの SHA-256、base64url。一意。Webhook で引くため）
  - `is_friend`（0／1。公式アカウントを友だち追加しているか）
  - `friend_changed_at`（`is_friend` を最後に変えたイベントの時刻。LINEの `timestamp`、またはコールバックで確かめた時刻）
  - `linked_at`、`updated_at`
- 同じLINEのアカウントで別の人が連携したら、前の人の行を消して付け替える（T-07 の購読の付け替えと同じ。1つのLINEのアカウントに2人分の合図が届かないように）。
- 解除・退会で行を消す（退会は CASCADE。T-16 の「本人のデータ」の「連携」に含める）。休眠（T-17。30日開いていない人の連携）は、カレンダーと違い埋まりの記録を持たないので対象にしない（確認事項5）。

### `line_oauth_states`
- T-06 の `calendar_oauth_states` と同じ形を notification の表として持つ（コンテキストの表を読み合わないため）。
- 列：`state_hash`（PK）、`binding_hash`、`user_id`（→ users、CASCADE）、`code_verifier`、`nonce`、`expires_at`（10分）、`used_at`、`created_at`。
- インデックス：`(user_id, created_at)`（開始の回数の上限）、`(created_at)`（掃除）。
- 期限を過ぎた行は、T-06 と同じ Cron で消す（1回に1000行）。

### `notifications`（T-07）の変更
- `channel` に `line` を足す。
- `outcome` に `coalesced`（未読の合図がLINEに届いているので送らなかった）を足す。
- 列 `counted_line_at`（null可）を足す。T-07 の `counted_push_at`・`counted_email_at` と同じ使い方。

### `notification_daily_counts`（T-07）の使い方の追加
- `channel = 'line'`：利用者ごとの1日のLINEの数（利用者のタイムゾーンの日付）。
- サービス全体の1か月のLINEの数：`user_id = ''`、`day = 'YYYY-MM'`（UTC の月）、`channel = 'line_month'`。T-07 の全体のメール数と同じく、`user_id = 'n:<お知らせの ID>'`・`channel = 'line_claim'` の印で二重に数えない。
- 掃除：`line_month` の行は、UTC で2か月前より前の月を消す。`day` の形が違うので、T-07 の「3日前より前」の掃除の条件から `channel IN ('line_month')` を外し、別の文で消す。

### 保持期間とプライバシー ポリシー
- `line_links`：解除・退会まで。`line_oauth_states`：10分。T-17「1.」の表と `packages/shared/src/retention.ts` に足す（実装PR）。
- プライバシー ポリシー（`/privacy`。T-19）：預かる情報（LINEの利用者ID）・外部に渡すもの（LINEヤフー株式会社に、LINEの利用者IDと合図の時刻と固定の文。LINEで送るを押したときの招待リンク）・保存期間を足す（実装PR）。T-19 の決まりで、効力が生じる前に知らせる。

## 振る舞い

### 連携の開始
1. 上限を確かめながら `line_oauth_states` に行を足す（T-06 の「連携の開始」と同じ。1人につき10分に10回、超えたら429と `Retry-After`）。
   - `state`・`binding`・`code_verifier`・`nonce` は、それぞれ32バイトのランダム値。D1 には `state`・`binding` のハッシュを置く。
2. 結びつけCookie `__Host-kh_line=<binding>` を設定する（HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600。T-01・T-06 の Cookie とは別の名前）。
3. `authorizeUrl` を返す。
   - `https://access.line.me/oauth2/v2.1/authorize`
   - `response_type=code`、`client_id=LINE_LOGIN_CHANNEL_ID`、`redirect_uri=${API_ORIGIN}/api/v1/line/callback`、`state`、`nonce`
   - `scope=openid`（名前・アイコン・メールは受け取らない）
   - `bot_prompt=aggressive`（許可の画面のあとに、公式アカウントの友だち追加をすすめる）
   - `code_challenge`・`code_challenge_method=S256`
- パラメータと応答の形は、実装の最初にLINEの公式で確かめる（確認事項2）。

### コールバック
1. `state` で行を取り出す（T-06 と同じ。`UPDATE ... SET used_at = ? WHERE state_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING ...`。同じ `state` は2回使えない）。
2. 結びつけCookieのハッシュを `binding_hash` と定数時間比較する。結果にかかわらず Cookie は消す。
3. `error` があれば失敗（許可の画面で断った）。
4. 認可コードを `code_verifier` とチャネルの認証情報で、LINEのトークンエンドポイント（`https://api.line.me/oauth2/v2.1/token`）に送る。
5. ID トークンを、LINEの検証のエンドポイント（`https://api.line.me/oauth2/v2.1/verify`）に、`client_id` と `nonce` を付けて送り、検証する。`sub` がLINEの利用者ID（`U` で始まる33文字。形が違えば失敗）。
6. アクセストークンで、友だちかどうか（`https://api.line.me/friendship/v1/status` の `friendFlag`）を取る。取れなければ `is_friend = 0` として続ける（Webhook の `follow` で追いつく）。
7. アクセストークンを失効させる（`https://api.line.me/oauth2/v2.1/revoke`）。失敗しても続ける（試みるだけ）。アクセストークン・リフレッシュトークン・ID トークンは保存しない。
8. 退会していない（`users.withdrawn_at IS NULL`）ときだけ、1つの batch で次を書く。
   - 同じ `line_user_id_hash` の、ほかの人の行を消す。
   - `line_links` に `INSERT ... ON CONFLICT(user_id) DO UPDATE` で書く（利用者IDを暗号化、`is_friend`、`friend_changed_at = 今`、`linked_at = 今`）。
9. 成功したら `/settings/notifications?line=linked` へ303。失敗はすべて `?line=failed` へ303で、理由は区別しない。
- ログには失敗の種類だけを出す（`line_link_failed`、`reason`）。コード・トークン・LINEの利用者ID・LINEの応答の本文は出さない。

### 状態と解除
- `GET /me/line-link`：閲覧者の `line_links` の行だけから作る。行がなければ `none`、`is_friend = 0` なら `needs_friend`、`1` なら `linked`。
- `DELETE /me/line-link`：`DELETE FROM line_links WHERE user_id = ?`。LINEの側で公式アカウントの友だちは外れないので、画面で「LINEで公式アカウントをブロックすると、トークからも消えます」と添える。

### Webhook
1. 本文を64KiBまで読む（超えたら読むのをやめて401。LINEのWebhookはこれより十分小さい）。
2. `x-line-signature` を、本文のバイト列と `LINE_MESSAGING_CHANNEL_SECRET` の HMAC-SHA256（base64）と、定数時間で比べる。合わなければ401（何も読まない・書かない・本文をログに出さない）。
3. `events[]` のうち、`type` が `follow`・`unfollow` で `source.type = 'user'` のものごとに、`source.userId` のハッシュで次を書く。
   - `UPDATE line_links SET is_friend = ?, friend_changed_at = ?, updated_at = ? WHERE line_user_id_hash = ? AND friend_changed_at < ?`（`?` はイベントの `timestamp`）。順番が入れ替わって届いても、古いイベントで戻さない。
   - 行がなければ何もしない（決定事項7）。
4. ほかのイベントは読み飛ばす。200を返す。
- 同じイベントが再送されても、上の文は同じ結果になる（冪等）。`webhookEventId` は保存しない。
- ログ：`line_webhook` に、扱ったイベントの種類ごとの数だけ。LINEの利用者ID・本文は出さない。署名が合わないときは `line_webhook_bad_signature`（数だけ）。
- 回数の上限：署名を確かめるまで D1 を読まないので、`RL_PUBLIC` は付けない（T-27 の画像の配信と同じ考え方）。T-10 の表にその旨を書く（実装PR）。

### 届ける（T-07 の「届ける」の手順3〜5に足す）
T-07 の手順2（止めた種別）のあと、手順3（送り先を決める）の前に、LINEを試す。

1. 種類が `new_login` なら、LINEを試さない（決定事項5）。
2. `line_links` に閲覧者の行があり `is_friend = 1` のときだけ、LINEを試す。なければ T-07 の手順3へ。
3. まとめる（決定事項4）：次の行があれば、送らずに `channel = 'line'`・`delivered_at`・`outcome = 'coalesced'` を書いて終える。
   - `SELECT 1 FROM notifications WHERE user_id = ? AND channel = 'line' AND outcome = 'sent' AND read_at IS NULL AND id != ? LIMIT 1`
   - 並びの前後は問わない（未読の合図が1つでも届いていればよい）。
4. 上限を確かめる（T-07 の手順4と同じ文の形。`counted_line_at` が NULL のときだけ数える）。
   - 利用者ごと：1日10件（`channel = 'line'`。誘い・募集・友達・予定・カレンダーをまとめて数える。まとめる（3.）があるので、ふつうは届かない数）。
   - サービス全体：1か月 `LINE_MONTHLY_LIMIT`（`line_month`）。
   - どちらかを超えたら、LINEを諦めて T-07 の手順3へ（`outcome = 'limited'` にしない。ほかの届け方で届ける）。全体の上限のときは `{ event: "notification_line_monthly_limit" }` のログを出す（T-13 の監視に足す。実装PR）。
5. 送る：`POST https://api.line.me/v2/bot/message/push`
   - ヘッダー：`Authorization: Bearer <LINE_MESSAGING_ACCESS_TOKEN>`、`Content-Type: application/json`、`X-Line-Retry-Key: <お知らせの ID>`（UUID。再試行で二重に送らない）。
   - 本文：`{ "to": "<LINEの利用者ID>", "messages": [{ "type": "text", "text": "ここ暇：新しいお知らせがあります\n${APP_ORIGIN}/notifications?openExternalBrowser=1" }], "notificationDisabled": false }`
   - `redirect: "manual"`、タイムアウト5秒（T-07 と同じ）。
6. 応答の扱い
   - 200、または409（同じ `X-Line-Retry-Key` を受け付け済み）：成功。`channel = 'line'`・`delivered_at`・`outcome = 'sent'` を書く。
   - 5xx・タイムアウト：一時的な失敗として投げる（Queue の再試行。T-07 と同じ）。
   - 429：LINEの1か月の通数の上限か、回数の上限。区別せず、このお知らせはLINEを諦めて T-07 の手順3へ（ログ `notification_line_rejected`、状態コード）。
   - 400・401・403・ほか：LINEを諦めて T-07 の手順3へ（ログ `notification_line_rejected`、状態コード）。行の `is_friend` は変えない（Webhook だけが変える）。
   - LINEで数えた分（`counted_line_at`）は戻さない。
- 受け入れること
  - 再試行の間に `X-Line-Retry-Key` の有効期間（LINEの公式で確かめる）を過ぎると、同じ合図が2回届くことがある。中身がないので受け入れる。
  - ブロックされたことを Webhook で知るまでの間は、LINEに送ろうとする（LINEは届けない）。その間のお知らせは、プッシュ・メールにも届かない。ブロックした本人の選択なので受け入れる（確認事項4）。
  - まとめた（`coalesced`）お知らせは、LINEにもプッシュ・メールにも届かない。お知らせ一覧で読む。

### 通知の設定（画面）
- `/settings/notifications`（T-07・T-11）の、プッシュの節の上に「LINEで受け取る」の節を足す。
  - `none`：「LINEで受け取る」のボタン。説明「お知らせがあることだけをLINEで知らせます。相手の名前や誘いの内容は送りません」。押すと `POST /me/line-link/start` を呼び、`authorizeUrl` へ画面遷移する。
  - `needs_friend`：「ここ暇の公式アカウントを友だち追加すると、LINEで受け取れます」と、`addFriendUrl` へのリンク「友だち追加」。「解除」。
  - `linked`：「LINEで受け取っています」と、「LINEで受け取っている間は、プッシュとメールは届きません（新しい端末でのログインはメールで届きます）」。「解除」。
  - 戻ってきたときの `?line=linked`：「LINEと連携しました」、`?line=failed`：「連携できませんでした。もう一度お試しください」を静かに出す（赤を使わない）。表示したら `history.replaceState` でクエリを消す。
- 状態は TanStack Query で `GET /me/line-link` を読む（`data-fetching` スキル）。解除のあとは無効にして読み直す。
- 文言は仮。`invitation-domain` スキルの用語表に合わせる。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `LINE_LOGIN_CHANNEL_ID` | vars | LINEログインのチャネルID |
| `LINE_LOGIN_CHANNEL_SECRET` | secret | LINEログインのチャネルシークレット |
| `LINE_MESSAGING_CHANNEL_SECRET` | secret | Messaging API のチャネルシークレット（Webhook の署名） |
| `LINE_MESSAGING_ACCESS_TOKEN` | secret | Messaging API のチャネルアクセストークン（長期）。漏れたら LINE Developers で発行し直す |
| `LINE_ADD_FRIEND_URL` | vars | 公式アカウントの友だち追加のURL |
| `LINE_MONTHLY_LIMIT` | vars | サービス全体の1か月のLINEの数の上限。正の整数でなければ0（LINEで送らない）として扱う |

- どれかがない・形が違うときは、LINEで受け取るを無効にする：`GET /me/line-link` は `available: false` を返し、画面は節を出さない。`start` は409 `invalid_state`。届け方はLINEを試さない。ほかの機能は止めない。ログは `line_config_invalid` だけ（値は出さない）。
- `dev-vars.example` と `scripts/write-e2e-dev-vars.mjs` に足す。`wrangler secret` で入れる手順を `docs/runbooks/line.md` に書く（実装PR）。

### E2E用の偽のLINE
- 偽の許可の画面 `/__e2e__/line/authorize`（API の `http://localhost:8787`）：`state` を受け取り、同意したことにしてコールバックへリダイレクトする（T-06 の偽の認可画面と同じ）。
- `e2eFetch` で、LINEのトークン・検証・友だちの状態・失効・push の宛先を偽の実装に向ける。偽の利用者IDは、テスト用ログインの利用者ごとに決まった値（`U` ＋32桁）。
- 偽の Webhook を送る `/__e2e__/line/webhook`（`E2E_MODE=1` のときだけ）：テストから `follow`・`unfollow` を正しい署名つきで本物の `/api/v1/line/webhook` に送る。
- 送った合図は T-07 の `/__e2e__/notifications/sent` に、`channel: 'line'` と本文の長さで出す。
- CI の本番ビルドの検査に、新しい名前（`/__e2e__/line/`）を足す。

## 認可と秘匿
- 閲覧者IDの使い方：`start`・状態・解除は `requireAuth`／`requireActiveSession` の閲覧者だけ。`line_links`・`line_oauth_states` は `user_id = 閲覧者` の条件でだけ読み書きする。コールバックの閲覧者は `state` に結びつけた利用者で、結びつけCookieで同じブラウザかを確かめる。
- 他人のデータに届かないことの保証：
  - 他人のLINE連携の状態は読めない。解除は自分の行だけ（他人の行を消せない）。
  - 攻撃者が始めた連携を被害者のブラウザで完了させ、被害者のお知らせを攻撃者のLINEに送らせることを、結びつけCookieで防ぐ（T-06 と同じ）。
  - Webhook は署名が合うものだけを扱い、`is_friend` の1列だけを変える。Webhook から、誰がここ暇を使っているかを推測できる応答を返さない（行があってもなくても同じ200）。
  - 受け入れるリスク：同じLINEのアカウントで別の人が連携すると、前の人の連携が消える（前の人はプッシュ・メールに戻る）。そのLINEのアカウントを操作できる人にしかできない。
- 区別させない応答（見せない／暇がない／募集の応答者など）：
  - LINEの合図は、T-07 のお知らせの作り方（どのイベントで誰に作るか）を変えない。LINEかどうかで、作るお知らせの有無・数・形は変わらない。
  - 合図に中身がないので、LINEのトーク・LINEヤフーに、相手・誘い・募集の応答者は渡らない。まとめる（`coalesced`）ので、LINEのトークに届く合図の数からも、お知らせの数は正確にはわからない。
- 外部に渡すもの：
  - LINE（LINEヤフー）：LINEの利用者ID、合図の時刻、固定の文とお知らせ一覧のURL。連携のときに、LINEログインの許可（`openid`）。LINEで送るを押したときの招待リンク。
  - ログに出すもの：イベント名・失敗の種類・状態コード・数だけ。LINEの利用者ID・トークン・チャネルシークレット・Webhook の本文は出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 正常系：連携の開始で `authorizeUrl` に `scope=openid`・`bot_prompt=aggressive`・`state`・`nonce`・`code_challenge_method=S256` が入り、`__Host-kh_line` が付く
- [ ] 正常系：コールバックで、トークンの交換 → 検証 → 友だちの状態 → 失効の順に呼び、`line_links` に暗号化した利用者IDとハッシュを書いて `?line=linked` へ303。トークンを保存しない
- [ ] 正常系：`GET /me/line-link` が `none`・`needs_friend`・`linked` を返し、`addFriendUrl` は `needs_friend` のときだけ入る
- [ ] 正常系：解除で行が消え、連携していなくても204
- [ ] 正常系：Webhook の `follow`・`unfollow` で `is_friend` が変わる。古い `timestamp` のイベントでは戻らない。同じイベントを2回送っても同じ
- [ ] 入力検証：`state` がない・使用済み・期限切れ・結びつけCookieが違う・`error` あり・検証の失敗・`sub` の形が違う、のどれも `?line=failed` で、`line_links` を書かない
- [ ] 入力検証：Webhook の署名がない・違う・本文が64KiBを超える、は401で何も書かない。`message` などほかのイベントは書かずに200
- [ ] 境界値・期限：連携の開始の11回めで429と `Retry-After`。`line_oauth_states` の10分ちょうど・過ぎたもの
- [ ] 他人のIDでは取得・更新できない：`GET`・`DELETE /me/line-link` は他人の行に届かない。他人の始めた `state` を自分の Cookie で使えない
- [ ] 付け替え：同じLINEの利用者IDで別の人が連携すると、前の人の行が消える
- [ ] 退会：退会した人にはコールバックで書かない。退会で `line_links` が消える（CASCADE）
- [ ] 届け方：`linked` の人にはLINEだけを送り、プッシュ・メールを呼ばない。本文が固定の文とURLだけで、名前・ひとことが入らない。`X-Line-Retry-Key` がお知らせの ID
- [ ] 届け方：`new_login` はLINEを試さずメール
- [ ] 届け方：未読のLINEの合図があれば `coalesced` で送らない。既読にすると次は送る
- [ ] 届け方：`needs_friend`・行なし・1日の上限・1か月の上限・429・4xx のときは、T-07 のプッシュ → メールで届く。5xx・タイムアウトは投げる。409は成功
- [ ] 届け方：同じお知らせを再試行しても、LINEの数を2回数えない
- [ ] 設定値：LINEの設定がないとき、`none` を返し、届け方はLINEを試さず、ほかの機能は動く
- [ ] ログ：LINEの利用者ID・トークン・Webhook の本文がログに出ない
- [ ] 秘匿：LINEで受け取る人とそうでない人で、作られるお知らせの数と形が同じ
- [ ] Web：招待リンクのシートの「LINEで送る」の `href` が `https://line.me/R/share?text=` で、本文に `?openExternalBrowser=1#t=` 付きの招待リンクが入る
- [ ] Web：通知の設定の3つの状態の表示、`?line=linked`・`?line=failed` の表示とクエリの削除、解除のあとの読み直し

### E2Eテスト（対象にする利用者の流れ）
- [ ] 通知の設定から「LINEで受け取る」を押し、偽の許可の画面を通って戻ると「LINEで受け取っています」と出る → 友達から誘いを送ると、偽のLINEに合図が1通届き、プッシュ・メールは届かない → もう1通誘いが届いても、未読の間はLINEに届かない → お知らせ一覧を開いたあとの誘いでは、また届く
- [ ] 偽の Webhook で `unfollow` を送ると、設定が「友だち追加すると〜」になり、次のお知らせはメールで届く
- [ ] 招待リンクを作ったシートの「LINEで送る」のリンク先が、`openExternalBrowser=1` 付きの招待リンクを本文に持つ（LINEは開かない）
- LINEのアプリ内ブラウザから外のブラウザに開き直す動きは、E2E では確かめられないので、実装PRで iOS・Android の実機で確かめ、PRに結果を書く。

## スコープ外
- LINEでのログイン（F-01）。LINEのプロフィール（名前・アイコン）の取り込み
- 中身のあるメッセージ、Flex Message・ボタン、トークからの返答（「行く」をLINEで押すなど）
- LINEのグループへの募集の投稿、LIFF、リッチメニュー、公式アカウントからの一斉配信
- 誘い・募集・予定のURLをLINEで送るボタン
- LINEのアプリ内ブラウザを見分けて案内を出すこと（UA の判定はしない。T-25 と同じ）
- 有料プランの契約（人が判断する）

## 確認事項（合意前に解消する）
1. **LINEの料金**：無料のプラン（仕様書を書いた時点の理解で1か月200通）で始め、`LINE_MONTHLY_LIMIT` を180にする案でよいか。超えた分はプッシュ・メールに戻る。友達の数が増えて足りなくなったら、有料のプランにするかを決める。
2. **LINEログインの細部**：`scope=openid` だけで利用者IDが取れるか、PKCE・`bot_prompt`・`friendship/v1/status`・失効・`X-Line-Retry-Key` の今の仕様を、実装の最初に公式で確かめる。違えばこの仕様書を直す。
3. **外のブラウザで開き直したときのフラグメント**：`openExternalBrowser=1` で開き直したときに `#t=` が残るか、iOS・Androidの実機で確かめる。残らなければ、LINE用のURLだけトークンをクエリに入れるか（T-02 の「サーバーのログに残さない」の例外になる）、「Safari で開いてください」の案内にするかを決める。
4. **ブロックの扱い**：ブロックを Webhook で知るまでの間、合図がどこにも届かないことを受け入れるか。受け入れないなら、push の応答で判断する方法を確かめる。
5. **休眠**：30日アプリを開いていない人の LINE連携を休眠にするか（T-17）。案は、休眠にしない（埋まりの記録のような行動の情報を持たないため）。
6. **LINEで受け取る人のプッシュ**：LINEだけにする（決定事項3）でよいか。プッシュもLINEも両方ほしい人がいれば、設定にスイッチを足す。

## 実装PRで直すもの（仕様書・要求定義書）
- docs/requirements.md：F-16 に LINE、非機能の図に `C --> LINE`、「API が外部を呼ぶのは〜だけ」に LINE連携のトークン交換、技術選定に LINE（Messaging API・LINEログイン）、外に出ている窓口に Webhook、リスクと対策
- docs/specs/T-07-notification.md：届け方の手順に LINE の節への参照、`channel`・`outcome` の値
- docs/specs/T-02-friends.md：招待リンクの発行の画面に「LINEで送る」
- docs/specs/T-10-idempotency-cache-ratelimit.md：連携の開始の上限、Webhook に上限を付けない理由
- docs/specs/T-16-withdrawal.md・T-17-retention.md・T-19-privacy-terms.md：LINE連携の削除・保存期間・本文

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書き | 新機能の候補の壁打ちから |
