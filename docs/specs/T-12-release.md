# T-12 仕様書：Web としての最初のリリースの準備

- 状態：下書き
- タスク票：docs/tasks/T-12-release.md
- 関係する要件：要求定義書「残りの論点」（XSS対策・Content-Security-Policy）、「AI時代の攻撃を前提にした運用」（使わないルートは閉じる）、F-01（ログイン）。issue pryusei/kokohima-app#42（アプリの中で行う部分）、#52

## 概要
- 最初のリリースは、友達だけ（Google のテストユーザーに登録した100人まで）に向けた Web アプリ（PWA）にする。アプリストアには出さない（利用者と決めた）。
- 画面（`apps/web` のビルド）を、API と同じ Worker の静的アセットとして `https://kokohima.app` から出す。`/api` と画面が同じオリジンになるので、今の `__Host-` の Cookie と Origin の検査がそのまま使える。
- ログインは Google だけにする。Sign in with Apple は設定で止め、コードは残す（Apple Developer Program を使わない。利用者と決めた）。
- 画面と API の応答に、ブラウザ向けのセキュリティのヘッダー（CSP・HSTS など）を付ける。

## 前提

### 確かめたこと（2026-11-21）
- 手元の wrangler（4.148）の設定のスキーマで、次の項目があることを確かめた。
  - `assets.run_worker_first`：真偽値か経路のパターンの配列。`true` なら、すべての要求がまず Worker のコードに届く。
  - `assets.not_found_handling`：`single-page-application`・`404-page`・`none`。
  - `routes[].custom_domain`（真偽値）、`workers_dev`（既定は true）、`preview_urls`（既定は false）。
- 公式の資料（developers.cloudflare.com）には、この環境からつながらず読めなかった。次のことは、仕様をこれに頼らない形にし、最初のデプロイのときに人が確かめる（#52）。
  - カスタムドメインを付けたとき、DNS の記録と証明書が自動で作られるか。
  - 静的アセットの `_headers` ファイルが Workers で効くか（この仕様では使わない。ヘッダーは Worker のコードで付ける）。

### コンテキストの分担
- `apps/api/src/worker.ts`（Worker の入口）で、要求を API（Hono のアプリ）と静的アセットに振り分け、セキュリティのヘッダーを付ける。domain・application には触らない。
- identity：Apple の経路の開け閉め（設定値で判断）。
- `apps/web`：ログインの画面と招待の画面で、Apple のボタンを出すかを、ビルドのときの設定値で決める。

### 実装PRで直すもの
- T-01 の仕様書：ログインの方法に「最初のリリースでは Apple は止める（T-12）」と、`APPLE_LOGIN_ENABLED` を足す。
- 要求定義書：F-01 の行に「最初のリリースは Google だけ」、「残りの論点」の XSS対策 を済みに（CSP は T-12）。構成図に「Web は API と同じ Worker の静的アセット」。
- infra/README.md：デプロイの手順（D1 のマイグレーション、`deploy:prod`）。
- issue #52 の本文：人が行う作業を、下の「人が行う作業」に合わせて書き直す（実装PRの説明にも載せる）。
- T-11（画面のデザイン）の実装PRが先にマージされていたら、新しいログインの画面・招待の画面に、同じ条件で Apple のボタンを出さない形を入れる。

## API
`api-conventions` スキルに従う。経路の追加はない。変わるのは次の2つ。

| メソッド | パス | 認証 | 変更 |
| --- | --- | --- | --- |
| GET | `/api/v1/auth/apple/start` | なし | Apple を止めた環境では、Apple の認可の画面へは送らず、`/login?error=login_failed` への303（T-01 の失敗と同じ。`oauth_transactions` も書かない） |
| POST | `/api/v1/auth/apple/callback` | なし | Apple を止めた環境では404（何も読まず、何も書かない） |

- `/api/` で始まらない要求は、静的アセット（画面）として返す（下の「振り分け」）。

## データ
- 変更なし（マイグレーションなし）。

## 振る舞い

### 振り分け（`apps/api/src/worker.ts`）
- wrangler の `assets` は prod の環境にだけ書く（ローカルの開発と E2E は、今までどおり vite が画面を出し、`/api` を wrangler dev へ中継する）。
  - `directory`：`../web/dist`、`binding`：`ASSETS`、`not_found_handling`：`single-page-application`、`run_worker_first`：`true`。
- Worker の `fetch` は次のとおりに振り分ける。振り分けとヘッダーの選び方は、同じ関数（`isApiPath(pathname)`：`URL.pathname` がデコードせずに `/api/` で始まるか）で決める。
  - パスが `/api/` で始まる：今までどおり Hono のアプリ。Hono が404を返しても、画面の `index.html` には置き換えない。
  - `/api`（末尾のスラッシュなし）・`//api/...`・`/%61pi/...`・`/API/...` は `/api/` で始まらないので、画面の側に回る（GET は `index.html`、ほかのメソッドは405）。Hono は `%` を含むパスをデコードしてから照合するが、Worker の判定はデコードしない値で行うので、安全な側（画面）に倒れる。
  - それ以外で、`ASSETS` のバインディングがある：`GET`・`HEAD` は `ASSETS.fetch(request)` の応答を返す。ほかのメソッドは405（本文なし、`Allow: GET, HEAD`）。
  - `ASSETS` のバインディングがない（ローカル・E2E・単体テスト）：今までどおり Hono のアプリ（404 などは今と同じ）。
  - E2E のエントリ（`src/e2e/entry.ts`）の `/__e2e__/*` は、今までどおり E2E のアプリで受ける（`ASSETS` は E2E の環境にないので、振り分けは変わらない）。
- 画面の経路（`/invites/xxx` など）は、`not_found_handling: single-page-application` で `index.html` が返る。
- `run_worker_first: true` なので、画面のファイルの要求も Worker の呼び出しに数える。友達だけの規模では有料プランの含まれる回数（月1,000万回）に対して小さいので受け入れる（ヘッダーをコードで付けて、テストで確かめられることを優先する）。

### セキュリティのヘッダー
- すべての応答（画面・API）に付ける。
  - API（`/api/`）の応答では、経路がすでに付けたヘッダーは上書きしない（T-08 の画像の経路の CSP・`Cache-Control` など）。
  - 画面（静的アセット）の応答では、下のヘッダーと `Cache-Control` を常に上書きする（静的アセットの既定のヘッダーや、将来置かれうる `_headers` より、コードの値を優先する）。`ASSETS.fetch` の応答のヘッダーは変えられないことがあるので、`new Response(res.body, res)` で作り直してから付ける。
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains`（`.app` はドメイン全体で HTTPS が必須だが、ほかのブラウザ・ツールのために付ける）
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- 画面の側（`/api/` 以外）の応答には、`Content-Type` に関係なく（HTML・SVG・304 など）、次の CSP を付ける。
  - `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`
  - インラインの script・style は許さない。ビルドした `index.html` にインラインの script・style があれば、実装PRで外に出す（CSP を緩めない）。
  - 画像は自分のオリジンだけ（OGP の画像は T-08 で自分のオリジンから出している。アバターの URL は今は外から読まない）。
- API の応答（`/api/`）で、経路が CSP を付けていなければ `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` を付ける（JSON をブラウザで開いても何も読み込ませない）。
- キャッシュ：画面の側の応答のうち、`/sw.js` と、`Content-Type` が `text/html` の応答（SPA の入口）には `Cache-Control: no-cache` を付ける（Service Worker と画面の入口が古いまま残らないように）。ほかの画面のファイルは、静的アセットの既定のまま。

### Apple のログインを止める
- 変数 `APPLE_LOGIN_ENABLED`（秘密ではない）。`"1"` のときだけ Apple の経路が動く。ほかの値・未設定は止める（fail closed）。
  - ローカル・e2e・単体テストは `"1"`（今の Apple のテストを残す）、staging・prod は `"0"`。
- 止めたときの経路の振る舞いは上の「API」の表のとおり。Apple の秘密（`APPLE_PRIVATE_KEY` など）が未設定でも、止めた環境では読まない。
  - 判定は、経路（routes）と application（`startLogin`・`handleCallback`）の両方に置く。経路では、本文の解析（`parseBody`）・`startLogin`・結びつけ Cookie の発行より前に判定する（「何も読まず、何も書かない」を順番で保証する。`Set-Cookie` も出さない）。
- 画面：ビルドのときの変数 `VITE_APPLE_LOGIN_ENABLED` が `"1"` のときだけ「Appleでログイン」を出す（ログインの画面と招待の画面）。既定は出さない。
  - 置き場は `playwright.config.ts` の webServer の command（`E2E=1 VITE_APPLE_LOGIN_ENABLED=1 pnpm --filter web dev`）と `apps/web/.env.development` だけ。`apps/web/.env` には書かない（`vite build` でも読まれるため）。本番のビルドでは付けない。
- Google のログイン・既存の Apple のアカウントの扱い（T-01）は変えない。

### ドメインと環境の設定（wrangler）
| 項目 | prod |
| --- | --- |
| `routes` | `kokohima.app`（`custom_domain: true`） |
| `workers_dev`・`preview_urls` | `false`・`false` |
| `APP_ORIGIN` | `https://kokohima.app` |
| `LINK_PREVIEW_OWN_DOMAINS` | `kokohima.app` |
| `MAIL_FROM` | `ここ暇 <notify@kokohima.app>` |
| `VAPID_SUBJECT` | `mailto:ops@kokohima.app`（プッシュのサービスが連絡先として有効な値を求めるため。受け取りは Cloudflare のメール転送で人のアドレスへ） |
| `APPLE_LOGIN_ENABLED` | `"0"` |
| `assets` | 上の「振り分け」 |
- staging は最初のリリースでは使わない（決定事項5）。wrangler の staging の環境は、`APPLE_LOGIN_ENABLED: "0"` を足すだけで、ほかは今のまま（作るときに prod と同じ形にそろえる）。Terraform の `envs/staging` も apply しない。
- `workers.dev` と プレビューの URL を閉じ、外に出す窓口を `kokohima.app` だけにする（要求定義書「使わないルートは閉じる」）。
  - `workers_dev: false`・`preview_urls: false` は、トップレベル（各環境に継承される）にも書く。誤って env の指定なしや `--env e2e` でデプロイしても、workers.dev に公開されないように（e2e の環境はテスト用ログインを含む）。
  - e2e の環境には `routes` を書かない。
- D1・KV の ID、VAPID の公開鍵、`NOTIFICATION_START_AT`、Google のクライアント ID は、人が値を決めて転記する（「人が行う作業」）。

### ビルドとデプロイのコマンド
- `pnpm --filter api build:prod`：`apps/web` をビルドしてから、`wrangler deploy --dry-run --env prod --outdir dist`。CI の本番のビルドの検査は、今の検査に加えて次を確かめる。
  - `apps/web/dist/index.html` があること。
  - `apps/web/dist` に E2E 用の名前（`__e2e__` など、今の検査と同じ一覧）がないこと。
  - `apps/web/dist` に `Appleでログイン` がないこと（本番のビルドで Apple のボタンが出ない）。
  - `apps/web/dist` に `_headers`・`_redirects` がないこと（ヘッダーと振り分けはコードだけで決める）。
  - `apps/web/dist/index.html` にインラインの script・style がないこと。
  - wrangler の設定：prod の `assets.run_worker_first` が `true`・`not_found_handling` が `single-page-application`、トップレベルと prod の `workers_dev`・`preview_urls` が `false`、e2e に `routes` がない（設定が変わってヘッダーが付かなくなるのを CI で気づくため）。
- `pnpm --filter api deploy:prod`（新しく足す）：`apps/web` をビルドしてから `wrangler deploy --env prod`。人だけが実行する（Claude は実行しない）。

### 人が行う作業（デプロイの前。#52 に載せる）
1. Cloudflare：`kokohima.app` の登録（済み）。用途を絞った API トークン。ゾーンの設定：
   - HTML に script を差し込む機能を切る：Rocket Loader・Email Obfuscation・Web Analytics（自動の挿入）・Zaraz・Bot Fight Mode の JavaScript detections（CSP で止まって動かなくなるため。CSP は緩めない）
   - 「Always Use HTTPS」を入れ、最小の TLS を 1.2 にする
   - `kokohima.app` に既存の A・AAAA・CNAME の記録があれば消す（カスタムドメインを付けられないため）
   - メール転送で `ops@kokohima.app` を人のアドレスへ転送する（`VAPID_SUBJECT`）
2. Terraform：`infra/terraform/envs/prod` で `plan`・`apply`（D1・KV・R2・Queues）。出力の D1・KV の ID を wrangler の prod に転記する PR を出す。
3. Google Cloud：本番の OAuth クライアント（公開ステータスは「テスト」）。
   - 承認済みのリダイレクト URI：`https://kokohima.app/api/v1/auth/google/callback` と `https://kokohima.app/api/v1/calendar/google/callback`
   - 同意画面のスコープ：`openid`・`email`・`profile` と、カレンダーの `calendar.freebusy`・`calendar.app.created`（T-06 決定事項1）
   - 友達の Google アカウントをテストユーザーに足す。クライアント ID を wrangler に転記。
   - 既知の制約：公開ステータスが「テスト」の間は、Google の更新用トークンが7日で失効するので、カレンダーの連携が毎週切れて「つなぎ直し」が要る（一般公開のときに審査を受けて解消する）。
4. Resend：`kokohima.app` を送信ドメインに足し、表示された SPF・DKIM・DMARC の記録を Cloudflare の DNS に足す。
5. 鍵と秘密（prod）：
   - VAPID の鍵の組を作り、公開鍵を wrangler に転記する。
   - `wrangler secret put --env prod` で `GOOGLE_CLIENT_SECRET`・`JWT_SIGNING_KEYS`・`CALENDAR_TOKEN_KEYS`・`RESEND_API_KEY`・`VAPID_PRIVATE_KEY`・`NOTIFICATION_KEYS`。Apple の秘密は要らない。
   - 鍵の JSON の kid は、vars の `JWT_CURRENT_KID`・`CALENDAR_TOKEN_CURRENT_KID`・`NOTIFICATION_CURRENT_KID`（`prod-1`）とそろえる。
   - ローカル・E2E の鍵（`.dev.vars`・`scripts/write-e2e-dev-vars.mjs`）を使い回さず、新しく作る。
   - `CALENDAR_TOKEN_KEYS`・`NOTIFICATION_KEYS` を失うと保存した値を復号できなくなるので、パスワードマネージャーなどに控えを残す。
   - Worker がまだない状態で `wrangler secret put` を実行すると空の Worker が作られる。その場合も、デプロイのあとに workers.dev が閉じていることを確かめる（手順9）。
6. `NOTIFICATION_START_AT` に、有効にする時刻を入れる。
7. `wrangler d1 migrations apply kokohima-prod --remote --env prod`。
8. `pnpm --filter api deploy:prod`。
9. 最初のデプロイのあとに確かめる：
   - `https://kokohima.app` が開き、証明書が有効。`/invites/xxx` を直接開ける。
   - `https://kokohima-api-prod.<サブドメイン>.workers.dev` が開かない。
   - `GET /api/v1/health` に共通のヘッダーと `default-src 'none'` の CSP が付く。画面の応答に画面用の CSP が付く。
   - `GET /api/v1/auth/apple/start` が `/login?error=login_failed` への303で、`Set-Cookie` が付かない。`POST /api/v1/auth/apple/callback` が404。
   - `POST /` と `POST /__e2e__/login` が405。
   - `wrangler secret list --env prod` に Apple の秘密と `E2E_MODE` がなく、vars にも `E2E_MODE` がない。
   - ブラウザのコンソールに CSP の違反が0件であることを、次の流れで確かめる：Google でログイン、招待を開いて友達になる、通知の購読、カレンダーの連携、リンクのプレビューの画像、Service Worker の登録。
   - 問題があれば `wrangler rollback --env prod` で戻す。
- staging は作らない（決定事項5）。

## 認可と秘匿
- 閲覧者IDの使い方：変わらない（API の経路は今のまま）。
- 他人のデータに届かないことの保証：変わらない。静的アセットは誰に対しても同じファイルで、利用者のデータを含まない。
- 区別させない応答：変わらない。Apple を止めた環境の `start` は、T-01 の失敗と同じ303にする（止めていることと、Apple の設定の誤りを区別させない）。
- ブラウザ：CSP でインラインの script と外のオリジンからの読み込みを止め、XSS の被害を小さくする。`frame-ancestors 'none'` と `X-Frame-Options` で、ほかのサイトに埋め込まれて押させる攻撃を防ぐ。`Referrer-Policy: no-referrer` で、外へのリンクにアプリの URL を渡さない。
- 外に出す窓口：`kokohima.app` だけ（`workers.dev`・プレビューの URL を閉じる）。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 振り分け：`/api/` は Hono のアプリ、それ以外の `GET`・`HEAD` は `ASSETS`（偽物）、`POST`・`OPTIONS` などは405と `Allow`（`POST /__e2e__/login` も405）。`ASSETS` がないときは今までどおり Hono のアプリ。`/api`・`//api/v1/me`・`/%61pi/v1/me`・`/API/v1/me` は画面の側に回る。`/api/` の下で Hono が404を返したとき、`index.html` に置き換わらない。
- [ ] ヘッダー：画面の側の応答（HTML・SVG・304）に画面用の CSP と共通のヘッダー。偽の `ASSETS` が弱い CSP や `Cache-Control` を付けて返しても、コードの値で上書きされる（偽物はヘッダーを変えられない応答を返し、作り直しを確かめる）。API の応答に共通のヘッダーと `default-src 'none'` の CSP。API の経路が付けたヘッダー（T-08 の画像の CSP・`Cache-Control`）は上書きしない。`/sw.js` と HTML は `Cache-Control: no-cache`。
- [ ] Apple を止める：`APPLE_LOGIN_ENABLED` が `"0"`・未設定・ほかの値なら、`start` は `/login?error=login_failed` への303で、`oauth_transactions` を書かず `Set-Cookie` も出さない。`callback` は本文を読まずに404。application の `startLogin`・`handleCallback` も Apple なら失敗を返す。`"1"` なら今までどおり（既存のテストが通る）。
- [ ] Web：`VITE_APPLE_LOGIN_ENABLED` がないとき、ログインの画面と招待の画面に「Appleでログイン」が出ない。`"1"` なら出る。
- [ ] ビルドと設定（CI の検査）：`build:prod` のあと、`apps/web/dist/index.html` があり、インラインの script・style・E2E 用の名前・`Appleでログイン`・`_headers`・`_redirects` がない。wrangler の設定の項目（`run_worker_first`・`not_found_handling`・`workers_dev`・`preview_urls`・e2e の `routes`）が仕様のとおり。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 既存の E2E がすべて通る（ローカルの開発と E2E は `VITE_APPLE_LOGIN_ENABLED=1`・`APPLE_LOGIN_ENABLED=1` で、今の流れのまま）。
- 新しい流れの E2E は足さない。E2E は vite と wrangler dev で動かしていて、静的アセットの振り分けとカスタムドメインは本番の Worker でしか動かないため。振り分けとヘッダーは単体テストで、本番の動きは「人が行う作業」の9で確かめる。

## スコープ外
- `wrangler deploy`・`terraform apply`・secret・Google と Resend の管理画面の設定（人が行う）。
- アプリストアへの公開、Apple のログイン、Apple カレンダー（T-09）。
- WAF・ボット対策・エッジのレート制限（#42 の残り）。
- 退会（#37）、古いデータの掃除（#38）、初回設定（#43）、画面のデザイン（T-11）。
- Google の審査（一般公開のときに行う）。

## 決定事項（仕様書PRのレビューで合意する）
1. 最初のリリースは、友達だけに向けた Web アプリ。ログインは Google だけ（利用者と決めた）。
2. ドメインは `kokohima.app`（利用者が取得済み）。画面と API を同じ Worker・同じオリジンから出す（提案）。
3. セキュリティのヘッダーは `_headers` ファイルでなく、Worker のコードで付ける（公式の資料で確かめられなかったことに頼らず、テストで確かめられる形にする）。そのため `run_worker_first: true` にする。（提案）
4. Apple は設定値で止め、コードは残す（あとで戻せるように）。（提案）
5. 最初のリリースは prod だけにし、staging は作らない（利用者と決めた）。

## 確認事項（合意前に解消する）
- 決定事項2〜4でよいか。
- 送信のメールアドレス `notify@kokohima.app` でよいか。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-21 | 初版 | 友達向けの最初のリリース（利用者と決めた） |
| 2026-11-21 | staging を作らないことにした。セキュリティのレビューを反映：画面の応答のヘッダーは常に上書き、CSP は画面の側の全応答に、振り分けの端の場合、wrangler の設定の CI の検査、トップレベルの `workers_dev: false`、Apple の判定の位置、`VITE_APPLE_LOGIN_ENABLED` の置き場、`VAPID_SUBJECT`、ゾーンの設定・鍵・Google の「テスト」の制約・デプロイのあとの確認と戻し方 | 利用者の回答、仕様書PRのレビュー（セキュリティ） |
