# T-01 仕様書：認証（Google／Sign in with Apple、セッション）

- 状態：下書き
- タスク票：docs/tasks/T-01-auth.md
- 関係する要件：F-01、NF-04、要求定義書「セキュリティ設計 › 認証とセッション」「テスト環境の認証」

## 概要
GoogleまたはSign in with Appleでログインし、再読み込みしてもログインが続くようにする。
API側でOpenID Connectの認可コードフロー（state・nonce・PKCE）を処理し、短命のアクセストークン（JWT、メモリのみ）と、ローテーションする更新用トークン（HttpOnly Cookie、D1にはハッシュのみ）を発行する。
以降のすべてのAPIが、認証済みの閲覧者IDを安全に受け取れるミドルウェアを用意する。

## 前提
- PWAとAPIは同じオリジンで配信する（例：`https://<アプリのドメイン>` の `/api/*` をAPI Workerにルーティング）。CORSは設定しない。ローカルではviteが `/api` をwrangler devへ中継し、同じオリジンになる（確認事項1）
- コンテキストは `identity`。`apps/api/src/identity/{domain,application,infra}` に置く

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/auth/google/start` | なし | query：`authStartQuerySchema`（`returnTo`） | 302：Googleの認可画面へ | なし |
| GET | `/api/v1/auth/google/callback` | なし（state＋結びつけCookie） | query：`code`、`state`（またはGoogleの `error`） | 303：`/auth/complete#code=<完了コード>`（失敗時は `/login?error=login_failed`） | 画面へのリダイレクトのみ（JSONは返さない） |
| GET | `/api/v1/auth/apple/start` | なし | query：`authStartQuerySchema` | 302：Appleの認可画面へ | なし |
| POST | `/api/v1/auth/apple/callback` | なし（state＋結びつけCookie） | form（`application/x-www-form-urlencoded`）：`code`、`state`（またはAppleの `error`） | 303：同上 | 同上 |
| POST | `/api/v1/auth/complete` | 完了コード＋Origin | JSON：`authCompleteRequestSchema` `{ code }` | 200：`authCompleteResponseSchema` `{ accessToken, expiresAt, returnTo }`（更新用トークンCookieを発行） | 401 `unauthenticated` |
| POST | `/api/v1/auth/refresh` | 更新用トークンCookie＋Origin | なし | 200：`refreshResponseSchema` `{ accessToken, expiresAt }` | 401 `unauthenticated` |
| POST | `/api/v1/auth/logout` | 更新用トークンCookie＋Origin | なし | 204（Cookieを消す） | 401 `unauthenticated`（Origin不一致のみ。Cookieがない・無効でも204） |
| POST | `/api/v1/auth/logout-all` | Bearer＋Origin | なし | 204（Cookieを消す） | 401 `unauthenticated` |
| GET | `/api/v1/me` | Bearer | なし | 200：`meResponseSchema` `{ id, displayName, avatarUrl }` | 401 `unauthenticated` |
| POST | `/__e2e__/login` | E2E環境のみ（下記） | JSON：`{ user: string }`（`^[a-z0-9-]{1,64}$`） | 204（更新用トークンCookieを発行） | 404 `not_found`（E2E環境以外）、400 `validation_failed` |

- スキーマは `packages/shared/src/schemas/identity.ts`。`/__e2e__/login` の入力スキーマは `apps/api/src/e2e/` に置き、sharedには置かない
- `returnTo`：次をすべて満たすパスだけを受け付ける。省略時や満たさないときは `/` に置き換える（エラーにせず、ログイン導線を壊さない）
  - 長さ512以下で、`/` で始まり、`//` や `/\` で始まらない
  - 制御文字（U+0000〜U+001F、U+007F）、空白、`\` を含まない（`/\t/evil.com` などがURLの解釈で `//evil.com` になるのを防ぐ）
  - `new URL(returnTo, APP_ORIGIN).origin === APP_ORIGIN`
  - 保存時（`/start`）と、完了時の応答の前の2回検証する
- `displayName` と `avatarUrl` は、初回設定（別タスク）までは `null`
- 例外：コールバックは利用者のブラウザが画面遷移で開くため、Problem DetailsのJSONではなく画面へのリダイレクトで失敗を伝える。失敗の理由は区別せず、すべて `error=login_failed`（キャンセルも含む）
- コールバックで直接セッションを作らず、完了コードを経由する理由：Appleのコールバックはクロスサイトのフォーム送信で届くため、その応答で設定する `SameSite=Strict` のCookieはブラウザに拒否されうる。同じオリジンの `fetch` で完了させれば、GoogleとAppleを同じ流れにでき、Cookieも確実に設定できる

## データ
マイグレーション `apps/api/migrations/0001_identity.sql` を追加する（Drizzleのスキーマは `apps/api/src/identity/infra/schema.ts`）。日時はすべてUnixミリ秒の整数。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `users` | `id`（UUID、PK）、`display_name`（null可）、`avatar_url`（null可）、`email`（null可）、`timezone`（既定 `Asia/Tokyo`）、`created_at`、`updated_at` | `email` は通知用（確認事項4） |
| `user_identities` | `id`（UUID、PK）、`user_id`（FK）、`provider`（`google` ／ `apple` ／ `e2e`）、`subject`（IDトークンの `sub`）、`created_at` | UNIQUE(`provider`, `subject`)。ユーザーの特定は `sub` で行い、メールアドレスでは行わない |
| `sessions` | `id`（UUID、PK＝更新用トークンの系列）、`user_id`（FK）、`created_at`、`last_used_at`、`expires_at`（系列の絶対期限）、`revoked_at`（null可） | INDEX(`user_id`) |
| `refresh_tokens` | `id`（UUID、PK）、`session_id`（FK）、`token_hash`（SHA-256、base64url、UNIQUE）、`created_at`、`expires_at`、`used_at`（null可） | INDEX(`session_id`)。生の値は保存しない |
| `oauth_transactions` | `state_hash`（PK）、`provider`、`nonce`、`code_verifier`、`binding_hash`、`return_to`、`expires_at` | 認可の開始からコールバックまでの一時データ。10分で失効。使ったら削除 |
| `login_codes` | `code_hash`（PK）、`user_id`（FK）、`provider`、`binding_hash`、`return_to`、`expires_at` | コールバックから完了までの一時データ。60秒で失効。使ったら削除 |
| `outbox` | `id`（UUID、PK）、`type`、`payload`（JSON）、`created_at`、`processed_at`（null可） | 外部連携の共通の箱。今回は書き込みのみ |

- 期限切れの `oauth_transactions`・`login_codes` と、失効・期限切れから30日を過ぎた `sessions`・`refresh_tokens` の掃除はCronで行う（掃除は別タスク。今回は列とインデックスだけ用意）

## 振る舞い

### ログインの開始（`/start`）
1. `state`（32バイト）、`nonce`（32バイト）、PKCEの `code_verifier`（32バイト）、結びつけ用の値 `binding`（32バイト）を `crypto.getRandomValues` で作り、base64urlで表す
2. `oauth_transactions` に `state` と `binding` のハッシュ、`nonce`、`code_verifier`、`returnTo` を保存する（10分）
3. 結びつけCookie `__Host-kh_oauth=<binding>` を設定する（HttpOnly、Secure、Path=/、Max-Age=600）
   - Google：`SameSite=Lax`
   - Apple：`SameSite=None`（Appleは `response_mode=form_post` でクロスサイトのPOSTを返すため。Laxでは送られない）
4. プロバイダの認可画面へ302でリダイレクトする
   - Google：`scope=openid email`、`code_challenge_method=S256`、`nonce`、`state`、`prompt=select_account`
   - Apple：`scope=email`、`response_mode=form_post`、`response_type=code`、`code_challenge_method=S256`、`nonce`、`state`

### コールバック
1. `state` のハッシュで `oauth_transactions` を条件付きで削除して取り出す（`DELETE ... RETURNING`。同じ `state` は2回使えない）。ない・期限切れ・プロバイダ違いは失敗
2. 結びつけCookieのハッシュが、保存した `binding_hash` と定数時間比較で一致しなければ失敗（別のブラウザで始めたログインを完了させない）。結びつけCookieはここでは消さない（完了で使う）。失敗したときだけ消す
3. 認可コードを、`code_verifier` とクライアントの認証情報でトークンエンドポイントに送り、IDトークンを受け取る
   - Apple のクライアントシークレットは、Secretsの秘密鍵でES256のJWTをその場で作る（`iss`＝チームID、`sub`＝Services ID、`aud`＝`https://appleid.apple.com`、有効期限5分）
   - フォームで直接届いた `id_token` と `user` は使わない（トークンエンドポイントの応答だけを信用する）
4. IDトークンを `jose` で検証する：署名（プロバイダのJWKS、`alg` はRS256のみ）、`iss`（Google：`https://accounts.google.com` または `accounts.google.com`、Apple：`https://appleid.apple.com`）、`aud`（自分のクライアントID）、`exp`・`iat`（許容誤差60秒）、`nonce`（保存した値と一致）
5. `(provider, sub)` で `user_identities` を探す
   - あれば、そのユーザーでログインする。`users.email` がnullで、IDトークンに確認済みのメールアドレスがあれば保存する（Googleは `email_verified` が真のときのみ）
   - なければ、`users` と `user_identities` を1つのバッチで作る（初回。メールアドレスの扱いは上と同じ）
6. 完了コード（32バイトのランダム値のbase64url）を作り、そのハッシュと、取り出した `binding_hash` を `login_codes` に保存して（60秒）、`/auth/complete#code=<完了コード>` へ303でリダイレクトする。コードはURLのフラグメントに入れ、サーバーのログやRefererに残さない
7. どこかで失敗したら、完了コードを作らず `/login?error=login_failed` へ303でリダイレクトする。ログには失敗の種類だけを出し、トークン・コード・メールアドレスは出さない

### ログインの完了（`POST /api/v1/auth/complete`）
1. `Origin` が `APP_ORIGIN` と一致しなければ401
2. 完了コードのハッシュで `login_codes` を条件付きで削除して取り出す（`DELETE ... RETURNING` を単独で実行）。ない・期限切れなら401
3. 結びつけCookie `__Host-kh_oauth` のハッシュが、`login_codes.binding_hash` と定数時間比較で一致しなければ401（攻撃者が自分の完了コードを被害者に開かせて、攻撃者のアカウントでログインさせる「ログインCSRF」を防ぐ）。結果にかかわらず結びつけCookieを消す。Apple用の `SameSite=None`、Google用の `SameSite=Lax` のどちらも、同じオリジンの `fetch` では送られる
4. 取り出した `user_id` でセッションを作り（下記）、更新用トークンCookieを設定し、アクセストークンと `returnTo` を返す
5. フロントの `/auth/complete` 画面は、フラグメントからコードを読んだらすぐ `history.replaceState` でURLから消し、このAPIを呼んで、成功したら `returnTo` へ、失敗したら `/login?error=login_failed` へ移る

### セッションと更新用トークン
- 更新用トークン：32バイトのランダム値のbase64url。D1にはSHA-256のハッシュだけを保存する
- Cookie：`__Host-kh_rt=<値>`、HttpOnly、Secure、`SameSite=Strict`、Path=/、Max-Age＝トークンの有効期限まで
- 有効期限：1本のトークンは30日（使われずに30日たつと失効）、系列（セッション）は作成から90日で失効（確認事項2）
- セッションを作るとき、`outbox` に `SessionStarted`（`userId`、`sessionId`、`provider`、`occurredAt`）を書く。新端末ログインのメール通知は通知タスクでこれを使う
- D1のバッチは文の結果で後続を止められない。そのため、条件つきの消費（`login_codes` の `DELETE ... RETURNING`、`refresh_tokens` の条件付きUPDATE）は先に単独で実行し、返った行や `meta.changes` を確かめてから、残りの書き込み（セッション・更新用トークン・`outbox` の作成）をバッチで行う

### 更新（`POST /api/v1/auth/refresh`）
1. `Origin` ヘッダーが設定値 `APP_ORIGIN` と完全一致しなければ401（`Origin` がない場合も401）
2. Cookieのトークンのハッシュで `refresh_tokens` とその `sessions` を取得する
3. 次のどれかなら401にしてCookieを消す：見つからない、トークンの期限切れ、セッションの失効・期限切れ
4. `used_at` が入っている（使用済み）なら、再利用とみなして、そのセッションを失効させてから401
5. `UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL` を単独で実行して使用済みにする。`meta.changes` が0なら（同時に使われた）、4と同じく再利用として扱い、6には進まない
6. 5が1行だったときだけ、同じセッションに新しいトークンを作り（バッチで `sessions.last_used_at` も更新）、Cookieを差し替えて、新しいアクセストークンを返す
- 新しいトークンの期限は `min(今＋30日, sessions.expires_at)`。Cookieの `Max-Age` もこれに合わせる

### アクセストークン
- JWT（HS256）。有効期限は10分。クレーム：`iss`＝`kokohima`、`aud`＝`kokohima-api`、`sub`＝ユーザーID、`sid`＝セッションID、`iat`、`exp`。ヘッダーに `kid`
- 署名鍵はSecrets `JWT_SIGNING_KEYS`（`{"<kid>": "<base64urlの32バイト以上の鍵>"}` のJSON）。署名には `JWT_CURRENT_KID` の鍵を使い、検証は `kid` で鍵を選ぶ（鍵の切り替えのため）
- 応答の `expiresAt` はISO 8601のUTC

### 認証ミドルウェア（`requireAuth`）
- `Authorization: Bearer <JWT>` を検証する（`alg` はHS256のみ、`kid` が未知なら失敗、`iss`・`aud`・`exp` を検証、許容誤差30秒）
- 成功したら `c.var.viewer = { userId, sessionId }` を設定する。application層の関数は `viewerId` を引数で受け取る
- 失敗したら401 `unauthenticated`。理由（期限切れ・署名不正など）は応答で区別しない
- 重要な操作のための `requireActiveSession`：`requireAuth` に加えて、D1で `sessions.revoked_at IS NULL` かつ期限内であることを毎回確認する。今回は `logout-all` で使う（以降のタスクで、アカウント連携・退会などに使う）

### ログアウト
- `logout`：Originを検査し、Cookieのトークンが属するセッションを失効させ、Cookieを消して204。Cookieがない・無効でも204（何度押しても同じ結果）
- `logout-all`：`requireActiveSession` とOriginを検査し、そのユーザーの全セッションを失効させ、Cookieを消して204
- 失効後もアクセストークンは最長10分有効だが、`requireActiveSession` を使う操作は即座に拒否される

### フロントエンド（apps/web）
- アクセストークンはモジュール内の変数（メモリ）にだけ持つ。localStorage・sessionStorage・IndexedDB・Cookieには保存しない
- 起動時に `POST /api/v1/auth/refresh` を呼ぶ。成功すればログイン状態、401ならログアウト状態
- APIクライアント（`apps/web/src/api/client.ts`）は、401を受けたら1回だけ更新して再送し、失敗したらログアウト状態にする（`data-fetching` スキル）
- 更新は複数タブで同時に走ると再利用と判定されるため、Web Locks API（`navigator.locks.request("kh-refresh", ...)`）で直列化する。ロックを取った後、他のタブが直前に更新していれば（`BroadcastChannel` で新しいトークンを受け取っていれば）それを使う（確認事項5）
- 画面（仮）：
  - ログイン画面（`/login`）：「Googleでログイン」「Appleでログイン」のボタン（`/api/v1/auth/<provider>/start?returnTo=...` への画面遷移）。`error=login_failed` のときは静かな文言で「ログインできませんでした。もう一度お試しください」を表示する（赤を使わない）
  - ログイン後の仮のホーム（`/`）：「ログイン中」の表示、「ログアウト」「すべての端末からログアウト」のボタン
  - 未ログインで `/` を開いたら `/login` へ。最終的なデザインはデザインのタスクで差し替える

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `APP_ORIGIN` | vars | PWAのオリジン（ローカル・E2Eは `http://localhost:5173`） |
| `GOOGLE_CLIENT_ID`、`APPLE_CLIENT_ID`（Services ID）、`APPLE_TEAM_ID`、`APPLE_KEY_ID` | vars | 公開されてよい識別子 |
| `GOOGLE_CLIENT_SECRET`、`APPLE_PRIVATE_KEY`、`JWT_SIGNING_KEYS` | secret | `wrangler secret` でのみ設定。ローカルは `.dev.vars`（コミットしない） |
| `JWT_CURRENT_KID` | vars | 署名に使う鍵ID |

- ローカルの `http://localhost` では、ブラウザがSecure Cookieと `__Host-` を許可するため、本番と同じCookie設定のまま動かす

### E2E用のテスト用ログイン
- `POST /__e2e__/login` を `apps/api/src/e2e/` に実装し、`src/e2e/entry.ts` からだけ読み込む（本番のエントリからの読み込みはESLintで禁止済み）
- `env.e2e` かつ `E2E_MODE=1` のときだけ有効。それ以外は404
- `user` で指定したキーのテスト用ユーザー（`provider=e2e`、`subject=<user>`）を、なければ作り、通常のログインと同じ処理（完了と同じセッション作成）で新しいセッションと更新用トークンCookieを発行する
- 認証状態はテストの間で使い回さない。更新用トークンはページを開くたびに交換され、同じトークンを別のテストが送ると再利用として系列ごと失効するため
  - Playwrightのfixture（`e2e/fixtures.ts`）で、テストごとに一意なキー（例：`a-<uuid>`）で `/__e2e__/login` を呼び、そのテスト専用のセッションで始める
  - 友達同士の流れでは、同じテストの中でA・B・Cの3人分を別々のブラウザコンテキストで作る
  - これに合わせて、実装PRで `e2e-testing` スキルの「認証」（setupプロジェクトで `storageState` を保存して使い回す方針）を書き換える（確認事項8）
- viteの中継に、環境変数 `E2E=1` で起動したときだけ `/__e2e__` を追加する（Cookieを `localhost:5173` で発行するため）。`playwright.config.ts` のwebServerは `E2E=1 pnpm --filter web dev` で起動するように変える
- wranglerの `env.e2e` はトップレベルの `vars` を引き継がないため、`APP_ORIGIN` などの設定値と、`JWT_SIGNING_KEYS` のE2E用の値を `env.e2e` 側にも置く（秘密情報はE2E専用のダミー値に限り、`.dev.vars.e2e` で渡す）
- CIで本番のビルド成果物に `__e2e__` が含まれないことを引き続き確認する。加えて、テスト用ログインの関数名（`e2eLogin`）が含まれないことも確認する

## 認可と秘匿
- 閲覧者IDの使い方：閲覧者は `requireAuth` が検証したJWTの `sub` からのみ得る。body・query・pathのユーザーIDは使わない。`GET /me` は閲覧者自身の行だけを `WHERE id = :viewerId` で取得する
- 他人のデータに届かないことの保証：このタスクで他人のデータを返すAPIはない。更新用トークンは、ハッシュの一致でしか自分のセッションに届かない。`logout-all` は閲覧者のセッションだけを `WHERE user_id = :viewerId` で失効させる
- 区別させない応答：
  - 401は理由（トークンなし、期限切れ、署名不正、セッション失効、再利用検知）を区別しない
  - コールバックの失敗は、理由にかかわらず同じ `error=login_failed`
  - `logout` はCookieの有無・有効性にかかわらず204
- 秘密情報：トークン、認可コード、IDトークン、メールアドレス、Cookieの値をログ・エラー応答に出さない。比較は定数時間比較

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 正常系：Googleで初回ログインするとユーザーと対応づけが作られ、2回目は同じユーザーになる（IDトークンはテスト用の鍵で署名し、トークンエンドポイントとJWKSは偽の実装に差し替える）
- [ ] 正常系：Appleでも同様（クライアントシークレットのJWTの形も確認）
- [ ] 拒否：`state` 不一致、`state` の再使用、期限切れの `state`、結びつけCookieの不一致・欠落
- [ ] 拒否：IDトークンの署名不正、`alg` 違い、`iss` 違い、`aud` 違い、期限切れ、`nonce` 不一致
- [ ] 失敗時に `error=login_failed` へリダイレクトし、完了コードもセッションも作られない
- [ ] 完了：完了コードは1回だけ使え、60秒で失効する。Originなし・別のOriginは401
- [ ] 完了：結びつけCookieがない・別のブラウザの値なら401（ログインCSRF）
- [ ] `returnTo` の検証：外部URL、`//evil`、`/\evil`、`/\t/evil.com`、`/%0a/evil.com` に相当する制御文字入り、512字超は `/` に置き換える
- [ ] 更新：正常にローテーションし、古いトークンは使えない
- [ ] 更新：使用済みのトークンを再利用すると、その系列のすべてのトークンが使えなくなる
- [ ] 更新：同時に2回使われた場合（条件付きUPDATEが0行）も再利用として扱う
- [ ] 更新：Originなし・別のOriginは401
- [ ] 更新：トークンの期限切れ、セッションの絶対期限切れは401
- [ ] D1の `refresh_tokens` に生の値が保存されていない（ハッシュのみ）
- [ ] Cookieの属性（HttpOnly、Secure、SameSite、Path、`__Host-`）
- [ ] `logout`：そのセッションだけが失効する。Cookieがなくても204
- [ ] `logout-all`：全セッションが失効し、どの更新用トークンも使えない。失効後の `logout-all` は401（`requireActiveSession`）
- [ ] `requireAuth`：期限切れ・署名不正・未知の `kid`・`alg=none` を拒否し、応答は同じ
- [ ] 他人のIDでは取得・更新できない：`GET /me` はBearerの本人だけを返し、queryやbodyのIDは無視される。ユーザーAの `logout-all` でユーザーBのセッションは失効しない
- [ ] `SessionStarted` が `outbox` に書かれる。ペイロードにメールアドレスやトークンを含まない
- [ ] E2E用：`E2E_MODE` が `1` 以外なら `/__e2e__/login` は404
- [ ] フロント：アクセストークンをlocalStorage・sessionStorageに保存しない。401で1回だけ更新して再送し、2回目の401でログアウト状態になる

### E2Eテスト（対象にする利用者の流れ）
- [ ] ログイン済み（テストごとのユーザー）でアプリを開くと「ログイン中」が表示され、再読み込みしても続く
- [ ] ログアウトするとログイン画面になり、再読み込みしてもログアウトのまま
- [ ] ログイン中、localStorage・sessionStorageにアクセストークンがない
- [ ] 未ログインで `/` を開くとログイン画面になる
- 本物のGoogle／Appleでのログインは対象外（`e2e-testing` スキル）。人が手動で確認する

## スコープ外
- アカウント連携（GoogleとAppleの統合）、退会
- 新端末ログインのメール通知（今回は `SessionStarted` を `outbox` に書くだけ）
- 初回設定（表示名とアイコン）。今回は `displayName`・`avatarUrl` がnullのまま
- 監査ログ（ログインの30日保持）。監査ログの仕組みとまとめて別タスクにする（確認事項6）
- レート制限（ログイン開始・コールバック・更新）。WAFとレート制限のインフラのタスクで行う（確認事項7）
- 期限切れデータの掃除（Cron）
- 最終的な画面デザイン

## 確認事項（合意前に解消する）
1. PWAとAPIを同じオリジンで配信する前提でよいか（Cookieを `SameSite=Strict`、`__Host-` にでき、CORSが不要になる）。別オリジンにする場合はCookieとCORSの設計をやり直す
2. 更新用トークンの有効期限：1本30日（使わなければ失効）、系列90日（再ログインが必要）でよいか
3. アクセストークンの有効期限：10分でよいか（要件は10〜15分）
4. メールアドレスを `users.email` に平文で保存してよいか（通知の送信先に必要。NF-04の暗号化はカレンダーの認証情報が対象という理解）
5. 複数タブの同時更新を、サーバー側の猶予ではなく、クライアント側のWeb Locksで直列化する方針でよいか
6. 監査ログ（ログインの記録）を、このタスクではなく監査ログの仕組みと一緒に別タスクで行ってよいか
7. ログイン・更新のレート制限を、インフラ（WAF・レート制限）のタスクに回してよいか
8. E2Eの認証状態をテストごとに作る方針（タスク票の「setupプロジェクトでユーザーA・B・Cの認証状態を用意」と `e2e-testing` スキルからの変更）でよいか。更新用トークンのローテーションと再利用検知を本番どおりに保つため
9. Sign in with AppleがPKCE（`code_challenge`・`code_verifier`）を受け付けるかを、実装の前に公式の資料と実機で確認する。受け付けない場合、AppleではPKCEを送らず、`state`・`nonce`・結びつけCookieとクライアントシークレットで守ることを仕様書に追記する

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-07 | 初版 | T-01の仕様書PR |
| 2026-10-07 | 完了コードを経由する流れ、ログインCSRF対策、`returnTo` の検証の強化、D1の条件付き処理の順序、E2Eの認証状態をテストごとに作る方針を追加 | 仕様レビューの指摘 |
