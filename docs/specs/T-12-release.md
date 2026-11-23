# T-12 仕様書：Web としての最初のリリースの準備

- 状態：実装済み
- タスク票：docs/tasks/T-12-release.md
- 関係する要件：要求定義書「残りの論点」（XSS対策・Content-Security-Policy）、「AI時代の攻撃を前提にした運用」（使わないルートは閉じる）、F-01（ログイン）。issue pryusei/kokohima-app#42（アプリの中で行う部分）、#52

## 概要
- 最初のリリースは、友達だけに向けた Web アプリ（PWA）にする（Google の OAuth は審査を受けずに本番の公開ステータスにする。決定事項7）。アプリストアには出さない（利用者と決めた）。
- 画面（`apps/web` のビルド）を、API と同じ Worker の静的アセットとして `https://kokohima.app` から出す。`/api` と画面が同じオリジンになるので、今の `__Host-` の Cookie と Origin の検査がそのまま使える。
- ログインは Google だけにする。Sign in with Apple は設定で止め、コードは残す（Apple Developer Program を使わない。利用者と決めた）。
- 画面と API の応答に、ブラウザ向けのセキュリティのヘッダー（CSP・HSTS など）を付ける。

## 前提

### 確かめたこと（2026-11-21）
- 手元の wrangler（4.161）の設定のスキーマで、次の項目があることを確かめた。
  - `assets.run_worker_first`：真偽値か経路のパターンの配列。`true` なら、すべての要求がまず Worker のコードに届く。
  - `assets.not_found_handling`：`single-page-application`・`404-page`・`none`。
  - `routes[].custom_domain`（真偽値）、`workers_dev`（既定は true）、`preview_urls`（既定は false）。
- 公式の資料（developers.cloudflare.com）には、この環境からつながらず読めなかった。料金（含まれる呼び出しの回数）も、この仕様書では確かめていない。次のことは、仕様をこれに頼らない形にし、最初のデプロイのときに人が確かめる（#52）。
  - カスタムドメインを付けたとき、DNS の記録と証明書が自動で作られるか。
  - 静的アセットの `_headers` ファイルが Workers で効くか（この仕様では使わない。ヘッダーは Worker のコードで付ける）。

### コンテキストの分担
- `apps/api/src/worker.ts`（Worker の入口）で、要求を API（Hono のアプリ）と静的アセットに振り分け、セキュリティのヘッダーを付ける。domain・application には触らない。
- identity：Apple の経路の開け閉め（設定値で判断）。
- `apps/web`：ログインの画面と招待の画面で、Apple のボタンを出すかを、ビルドのときの設定値で決める。

### 実装PRで直したもの
- T-01 の仕様書：ログインの方法に「最初のリリースでは Apple は止める（T-12）」と、`APPLE_LOGIN_ENABLED` を足す。
- 要求定義書：F-01 の行に「最初のリリースは Google だけ」、「残りの論点」の XSS対策 を済みに（CSP は T-12）。構成図に「Web は API と同じ Worker の静的アセット」。
- infra/README.md：デプロイの手順（D1 のマイグレーション、`deploy:prod`）。
- issue #52 の本文：人が行う作業を、下の「人が行う作業」に合わせて書き直す（実装PRの説明にも載せる）。
- T-01 の仕様書：13行目の「`/api/*` をAPI Workerにルーティング」を「同じ Worker の静的アセット」に、ログインの画面の「Appleでログイン」と「Apple は staging で人が手動で確認」を、Apple を止めた形に直す。
- T-07 の仕様書：設定値の表の `VAPID_SUBJECT`・`MAIL_FROM` の例を prod の値に。
- T-08 の仕様書：設定値の表の `LINK_PREVIEW_OWN_DOMAINS`（「本番のドメインが決まるまで `example.invalid`」）を `kokohima.app` に。
- 要求定義書：構成図（「Pages PWAの配信」→ 同じ Worker の静的アセット）、F-01、認証の表のログイン手段、STRIDE のなりすまし、「残りの論点」の XSS。
- infra/README.md：「環境」の staging の記述（最初のリリースでは作らない）、初回の手順を prod の例に、カスタムドメインの DNS は Workers が管理すること（決定事項6）。
- T-11 の仕様書：「Apple のボタンは `VITE_APPLE_LOGIN_ENABLED` が `"1"` のときだけ出す（T-12）」を1行足す。T-11 の実装が新しいログインの画面・招待の画面に置き換えても、この条件を残すため。T-11 の実装PRが先にマージされていたら、新しい画面に同じ条件を入れる。
- wrangler の staging の環境に「最初のリリースではデプロイしない」の注釈。
- `.gitignore`：`!apps/web/.env.development` の例外。

## API
`api-conventions` スキルに従う。経路の追加はない。変わるのは次の2つ。

| メソッド | パス | 認証 | 変更 |
| --- | --- | --- | --- |
| GET | `/api/v1/auth/apple/start` | なし | Apple を止めた環境では、Apple の認可の画面へは送らず、`/login?error=login_failed` への303（T-01 の失敗と同じ。`oauth_transactions` も書かない） |
| POST | `/api/v1/auth/apple/callback` | なし | Apple を止めた環境では404（何も読まず、何も書かない） |

- `/api/` で始まらない要求は、静的アセット（画面）として返す（下の「振り分け」）。
- 新しい経路を足さないので、表の列は「変更」だけにした（入力・出力の形は T-01 のまま）。
- Apple を止めた `start` は、T-10 の回数の上限（`auth_start`）のあとで判定し、今の `loginFailed`（結びつけ Cookie の削除と `Cache-Control: no-store` を付けた303）と同じ応答を返す。新しい結びつけ Cookie は発行しない。
- Apple を止めた `callback` の404は、`app.notFound` と同じ problem+json の `404 not_found`。

## データ
- 変更なし（マイグレーションなし）。

## 振る舞い

### 振り分け（`apps/api/src/worker.ts`）
- wrangler の `assets` は prod の環境と、デプロイしないローカル専用の `assets` の環境（本番と同じ形の E2E 用）にだけ書く（ローカルの開発と E2E は、今までどおり vite が画面を出し、`/api` を wrangler dev へ中継する）。
  - `directory`：`../web/dist`、`binding`：`ASSETS`、`not_found_handling`：`single-page-application`、`run_worker_first`：`true`。
- Worker の `fetch` は次のとおりに振り分ける。振り分けとヘッダーの選び方は、同じ関数（`isApiPath(pathname)`：`URL.pathname` がデコードせずに `/api/` で始まるか）で決める。
  - パスが `/api/` で始まる：今までどおり Hono のアプリ。Hono が404を返しても、画面の `index.html` には置き換えない。
  - `/api`（末尾のスラッシュなし）・`/apix`・`//api/...`・`/%61pi/...`・`/API/...` は `/api/` で始まらないので、画面の側に回る（GET は `index.html`、ほかのメソッドは405）。Hono は `%` を含むパスをデコードしてから照合するが、Worker の判定はデコードしない値で行うので、安全な側（画面）に倒れる。
  - それ以外で、`ASSETS` のバインディングがある：`GET`・`HEAD` は `ASSETS.fetch(request)` の応答を返す。ほかのメソッドは405（本文なし、`Allow: GET, HEAD`）。
  - `ASSETS` のバインディングがない（ローカル・E2E・単体テスト）：今までどおり Hono のアプリ（404 などは今と同じ）。
  - E2E のエントリ（`src/e2e/entry.ts`）の `/__e2e__/*` は、今までどおり E2E のアプリで受ける（`ASSETS` は E2E の環境にないので、振り分けは変わらない）。
- 画面の経路（`/invites/xxx` など）は、`not_found_handling: single-page-application` で `index.html` が返る。
- `run_worker_first: true` なので、画面のファイルの要求も Worker の呼び出しに数える（料金は確かめていないが、友達だけの規模では小さいとみて受け入れる。ヘッダーをコードで付けて、テストで確かめられることを優先する）。

### セキュリティのヘッダー
- すべての応答（画面・API）に付ける。
  - API（`/api/`）の応答では、経路がすでに付けたヘッダーは上書きしない（T-08 の画像の経路の CSP・`Cache-Control` など）。
  - 画面（静的アセット）の応答では、下のセキュリティのヘッダーを常に上書きする（静的アセットの既定のヘッダーや、将来置かれうる `_headers` より、コードの値を優先する）。`Cache-Control` は下の「キャッシュ」のとおり（`/sw.js` と HTML だけ上書きし、ほかは静的アセットの既定のまま）。`ASSETS.fetch` の応答のヘッダーは変えられないことがあるので、`new Response(res.body, res)` で作り直してから付ける。
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains`（`.app` はドメイン全体で HTTPS が必須だが、ほかのブラウザ・ツールのために付ける。`.app` は TLD ごと preload の一覧に入っているので、`preload` は付けない）
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
- 画面の側（`/api/` 以外）の応答には、`Content-Type` に関係なく（HTML・SVG・304 など）、次の CSP を付ける。
  - `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`
  - インラインの script・style は許さない。ビルドした `index.html` にインラインの script・style があれば、実装PRで外に出す（CSP を緩めない）。
  - `eval`・`new Function` も許さない。Zod は最初の検証で `new Function` を試し、捕まえても CSP の違反が報告されるので、画面の入口（`apps/web/src/main.tsx` が最初に読む `zodConfig.ts`）で `config({ jitless: true })` にする（検証の結果は変わらない。本番と同じ形の E2E で見つけた）。
  - 画像は自分のオリジンだけ（OGP の画像は T-08 で自分のオリジンから出している。アバターの URL は今は外から読まない）。
- API の応答（`/api/`）で、経路が CSP を付けていなければ `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` を付ける（JSON をブラウザで開いても何も読み込ませない）。
- `ASSETS` のバインディングがない環境（ローカル・E2E・単体テスト）では、Hono が返すすべての応答（`/__e2e__/*` も含む）を API の応答として扱い、API のヘッダーを付ける。
- キャッシュ：画面の側の応答のうち、パスが `/sw.js` の応答と、`Content-Type` が `text/html` の応答（SPA の入口。`Content-Type` がない304は、パスが `/`・`.html` で終わる・拡張子がない（SPA の経路）なら HTML とみなす）には `Cache-Control: no-cache` を付ける（Service Worker と画面の入口が古いまま残らないように）。ほかの画面のファイルは、静的アセットの既定のまま。

### Apple のログインを止める
- 変数 `APPLE_LOGIN_ENABLED`（秘密ではない）。`"1"` のときだけ Apple の経路が動く。ほかの値・未設定は止める（fail closed）。
  - ローカル・e2e・assets・単体テストは `"1"`（今の Apple のテストを残す）、staging・prod は `"0"`。置き場は wrangler.jsonc のトップレベルの `vars`、`env.e2e.vars`・`env.assets.vars`（env の vars はトップレベルの vars を引き継がない）、`env.staging.vars`・`env.prod.vars`、`vitest.config.ts` の bindings。
  - `env.ts` の `Bindings` に `APPLE_LOGIN_ENABLED?: string` と `ASSETS?: Fetcher` を足す。
- 止めたときの経路の振る舞いは上の「API」の表のとおり。Apple の秘密（`APPLE_PRIVATE_KEY` など）が未設定でも、止めた環境では読まない。
  - 判定は、経路（routes）と application（`startLogin`・`handleCallback`）の両方に置く。経路では、本文の解析（`parseBody`）・`startLogin`・結びつけ Cookie の発行より前に判定する（「何も読まず、何も書かない」を順番で保証する。新しい結びつけ Cookie は発行しない。`loginFailed` と同じく、結びつけ Cookie を消す `Set-Cookie` だけは出る）。
- 画面：ビルドのときの変数 `VITE_APPLE_LOGIN_ENABLED` が `"1"` のときだけ「Appleでログイン」を出す（ログインの画面と招待の画面）。既定は出さない。
  - 置き場は、コミットする `apps/web/.env.development`（`VITE_APPLE_LOGIN_ENABLED=1`）だけ。今の `.gitignore` の `.env.*` に当たるので、`.gitignore` に `!apps/web/.env.development` の例外を足す（秘密を書かないファイルなのでコミットしてよい。ほかの `.env.*` は今までどおり無視する）。`vite build` は production のモードなので読まない。`apps/web/.env` には書かない（`vite build` でも読まれるため）。E2E は vite の開発のサーバーなので、`.env.development` で `"1"` になる。
  - Web の単体テスト（Vitest は test のモードで `.env.development` を読まない）は `vi.stubEnv` で切り替える。`ImportMetaEnv` の型に `VITE_APPLE_LOGIN_ENABLED?: string` を足す。
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
- `www.kokohima.app` は扱わない（DNS の記録を作らず、開かない）。
- `workers.dev` と プレビューの URL を閉じ、外に出す窓口を `kokohima.app` だけにする（要求定義書「使わないルートは閉じる」）。
  - `workers_dev: false`・`preview_urls: false` は、トップレベル（各環境に継承される）にも書く。誤って env の指定なしや `--env e2e` でデプロイしても、workers.dev に公開されないように（e2e の環境はテスト用ログインを含む）。
  - e2e の環境には `routes` を書かない。
- D1・KV の ID、VAPID の公開鍵、Google のクライアント ID は、人が値を決めて、実装PRのマージのあとの別の PR で wrangler.jsonc に転記する（実装PRでは TODO のまま）。
- `NOTIFICATION_START_AT` は prod では `"1"` にする（prod の D1 は新しく作るので、古い outbox の行がない。T-07 の「古い outbox の行」の線は要らない）。実装PRで書く。

### ビルドとデプロイのコマンド
- `pnpm --filter api build:prod`：`apps/web` をビルドしてから、`wrangler deploy --dry-run --env prod --outdir dist`。CI の本番のビルドの検査は、今の検査に加えて次を確かめる。
  - `apps/web/dist/index.html` があること。
  - `apps/web/dist` に E2E 用の名前（`__e2e__` など、今の検査と同じ一覧）がないこと。
  - `apps/web/dist` に `Appleでログイン` と、Apple のボタンの目印 `data-provider="apple-login"` がないこと（本番のビルドで Apple のボタンが出ない。文言が変わっても目印で見つける。URL は実行時に組み立てるので、`auth/apple/start` の文字列では見つからない）。
  - `apps/web/dist` に `_headers`・`_redirects` がないこと（ヘッダーと振り分けはコードだけで決める）。
  - `apps/web/dist/index.html` にインラインの script・style（`style=` の属性を含む）がないこと。
  - wrangler の設定：prod の `assets.run_worker_first` が `true`・`not_found_handling` が `single-page-application`・`binding` が `ASSETS`、トップレベルと prod の `workers_dev`・`preview_urls` が `false`、prod の `routes` が `kokohima.app`（`custom_domain`）だけ、prod の `APPLE_LOGIN_ENABLED` が `"0"` で `E2E_MODE` がない、トップレベルと prod の `main` が `src/index.ts`、どの環境も `workers_dev`・`preview_urls` を `true` にしない、prod 以外の環境とトップレベルに `routes` がない（設定が変わってヘッダーが付かなくなるのを CI で気づくため）。
- `pnpm --filter api deploy:prod`（新しく足す）：`apps/web` をビルドし、CI と同じ検査（画面のビルド・wrangler の設定・`--dry-run` で作った API のビルドに E2E 用の経路がないこと。`apps/api/scripts/check-*.mjs`）を通してから `wrangler deploy --env prod`。手元の `.env.local` などが本番のビルドに入り込んでも、ここで止まる。人だけが実行する（Claude は実行しない）。
  - `deploy:prod` だけ、転記を忘れた値も検査する（`check-wrangler-config.mjs --deploy`）：prod の `vars.GOOGLE_CLIENT_ID`・`vars.VAPID_PUBLIC_KEY` が空、または prod の D1 の `database_id`・KV の `id` がすべて0の仮の値なら止まる。CI の `build:prod` は TODO のままの設定でビルドするので、この検査を付けない。
- `pnpm --filter api db:migrate:prod`（新しく足す）：`wrangler d1 migrations apply DB --remote --env prod`（prod の `DB` のバインディング＝`kokohima-prod`）。人だけが実行する。

### 人が行う作業（デプロイの前。#52 に載せる）
1. Cloudflare：`kokohima.app` の登録（済み）。Workers の有料プラン（Queues に要る。NF-09）。API トークンは用途ごとに分ける（要求定義書「APIトークンは用途ごとに分ける」）：
   - Terraform 用（`CLOUDFLARE_API_TOKEN`）：D1・KV・R2・Queues の編集
   - デプロイ用（`wrangler deploy` と `wrangler secret`）：Workers のスクリプト、Workers のルートとカスタムドメイン（ゾーンの DNS と証明書）、D1（マイグレーション）
   - どちらも、`CLOUDFLARE_ACCOUNT_ID` と一緒に、人の端末だけで使う
   ゾーンの設定：
   - HTML に script を差し込む機能を切る：Rocket Loader・Email Obfuscation・Web Analytics（自動の挿入）・Zaraz・Bot Fight Mode の JavaScript detections（CSP で止まって動かなくなるため。CSP は緩めない）
   - 「Always Use HTTPS」を入れ、最小の TLS を 1.2 にする
   - `kokohima.app` に既存の A・AAAA・CNAME の記録があれば消す（カスタムドメインを付けられないため）
   - メール転送で `ops@kokohima.app` を人のアドレスへ転送する（`VAPID_SUBJECT`）
2. Terraform（infra/README.md の初回の手順を prod で）：状態ファイル用の R2 バケット `kokohima-tfstate` を作る → `infra/terraform/envs/prod` で `terraform init -backend-config=...` → `plan -var account_id=...` → `apply`（D1・KV・R2・Queues）。出力の D1・KV の ID を wrangler の prod に転記する PR を出す（Claude に頼んでよい）。
3. Google Cloud：プロジェクトで Google Calendar API を有効にする。同意画面（ユーザーの種類は「外部」、公開ステータスは「本番」。審査は受けない。決定事項7）と、本番の OAuth クライアント（ウェブ アプリケーション）。
   - 承認済みのリダイレクト URI：`https://kokohima.app/api/v1/auth/google/callback` と `https://kokohima.app/api/v1/calendar/google/callback`
   - 同意画面のスコープ：`openid`・`email`・`profile` と、カレンダーの `calendar.freebusy`・`calendar.app.created`（T-06 決定事項1）
   - クライアント ID を wrangler に転記。
   - 同意画面の「対象」で「アプリを公開」を押し、公開ステータスを「本番」にする（テストユーザーの登録は要らない）。押したときの画面の説明（審査の要否・人数の上限）を確かめ、下の「本番にしたときの扱い」と違えば、この仕様書を直す。
   - 本番にしたときの扱い（決定事項7。公式の資料はこの作業環境から読めなかったため、公開の画面の説明で確かめる）：
     - ログイン（`openid`・`email`・`profile`。審査の要らないスコープ）は、Google アカウントがあれば誰でもでき、確認されていないアプリの警告は出ない。
     - カレンダーの連携（`calendar.freebusy`・`calendar.app.created`。審査の対象のスコープ）では、「Google はこのアプリを確認していません」の画面が出る。利用者は「詳細」から進む。審査を受けるまで、連携できる人数に上限（100人）がある。
     - 「テスト」のときの、更新用トークンが7日で失効する制約はなくなる（毎週の `needs_reauth` と「つなぎ直し」のお知らせは起きない）。
   - 誰でも Google でログインしてアカウントを作れるようになるが、ここ暇・誘い・募集が見えるのは招待リンクで友達になった相手だけ（T-02・T-03）なので、知らない人に友達の暇は見えない。
4. Resend：`kokohima.app` を送信ドメインに足し、表示された記録（SPF・DKIM と、送信用のサブドメインの MX）に DMARC を加えて、Terraform の `cloudflare_dns_record` で足す PR を出す（infra/README.md「管理画面で手動変更しない」。値を受け取れば Claude が PR を書く）。
5. 鍵と秘密（prod）：
   - VAPID の鍵の組を作る（秘密鍵は P-256 の PKCS#8 の PEM、公開鍵は base64url の非圧縮の点。T-07）。公開鍵を wrangler に転記する。
   - `wrangler secret put --env prod` で `GOOGLE_CLIENT_SECRET`・`JWT_SIGNING_KEYS`・`CALENDAR_TOKEN_KEYS`・`RESEND_API_KEY`・`VAPID_PRIVATE_KEY`・`NOTIFICATION_KEYS`。Apple の秘密は要らない。
   - `JWT_SIGNING_KEYS`・`CALENDAR_TOKEN_KEYS`・`NOTIFICATION_KEYS` は `{"prod-1":"<base64url の32バイト>"}` の形で、3つとも別の値（作り方は `apps/api/dev-vars.example`）。鍵の JSON の kid は、vars の `JWT_CURRENT_KID`・`CALENDAR_TOKEN_CURRENT_KID`・`NOTIFICATION_CURRENT_KID`（`prod-1`）とそろえる。
   - ローカル・E2E の鍵（`.dev.vars`・`scripts/write-e2e-dev-vars.mjs`）を使い回さず、新しく作る。
   - `CALENDAR_TOKEN_KEYS`・`NOTIFICATION_KEYS` を失うと保存した値を復号できなくなるので、パスワードマネージャーなどに控えを残す。
   - Worker がまだない状態で `wrangler secret put` を実行すると空の Worker が作られる。その場合も、デプロイのあとに workers.dev が閉じていることを確かめる（手順9）。
6. 2・3・5 の転記の PR をマージする。
7. `pnpm --filter api db:migrate:prod`。
8. `pnpm --filter api deploy:prod`。
9. 最初のデプロイのあとに確かめる：
   - `https://kokohima.app` が開き、証明書が有効。`/invites/xxx` を直接開ける。`www.kokohima.app` は開かない。
   - Cloudflare の DNS に、カスタムドメインの記録が Workers によって作られている（作られていなければ、仕様を見直す）。
   - `https://kokohima-api-prod.<サブドメイン>.workers.dev` が開かない。
   - `GET /api/v1/health` に共通のヘッダーと `default-src 'none'` の CSP が付く。画面の応答に画面用の CSP が付く。
   - `GET /api/v1/auth/apple/start` が `/login?error=login_failed` への303で、新しい結びつけ Cookie が付かない（消す `Set-Cookie` だけ）。`POST /api/v1/auth/apple/callback` が404。
   - `POST /` と `POST /__e2e__/login` が405。
   - `curl -I https://kokohima.app//example.com/index.html` などの `//` で始まるパスが、ほかのサイトへのリダイレクト（`Location` が `//example.com/...` や `https://example.com/...`）にならない（画面の `index.html` か、`kokohima.app` の中への応答）。
   - `wrangler secret list --env prod` に Apple の秘密と `E2E_MODE` がなく、vars にも `E2E_MODE` がない。
   - ブラウザのコンソールに CSP の違反が0件であることを、次の流れで確かめる：Google でログイン、招待を開いて友達になる、通知の購読、カレンダーの連携、リンクのプレビューの画像、Service Worker の登録。
   - 問題があれば `wrangler rollback --env prod` で戻す。
- staging は作らない（決定事項5）。

## 認可と秘匿
- 閲覧者IDの使い方：変わらない（API の経路は今のまま）。
- 他人のデータに届かないことの保証：変わらない。静的アセットは誰に対しても同じファイルで、利用者のデータを含まない。
- 区別させない応答：変わらない。Apple を止めていることは隠さない（動いている `start` は Apple への302を返すので、外から区別できる。隠す対象ではない）。止めた `start` は、画面の扱いをそろえるために T-01 の失敗と同じ303にする。
- ブラウザ：CSP でインラインの script と外のオリジンからの読み込みを止め、XSS の被害を小さくする。`frame-ancestors 'none'` と `X-Frame-Options` で、ほかのサイトに埋め込まれて押させる攻撃を防ぐ。`Referrer-Policy: no-referrer` で、外へのリンクにアプリの URL を渡さない。
- 外に出す窓口：`kokohima.app` だけ（`workers.dev`・プレビューの URL を閉じる）。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 他人のIDでは取得・更新できない：対象外（新しい経路・データの取得を足さない。既存の経路のテストはそのまま通る）。
- [x] 振り分け：`/api/` は Hono のアプリ、それ以外の `GET`・`HEAD` は `ASSETS`（偽物）、`POST`・`OPTIONS` などは405と `Allow`（`POST /__e2e__/login` も405）。`ASSETS` がないときは今までどおり Hono のアプリ。`/api`・`/apix`・`//api/v1/me`・`/%61pi/v1/me`・`/API/v1/me` は画面の側に回る。`/api/` の下で Hono が404を返したとき、`index.html` に置き換わらない。
- [x] ヘッダー：画面の側の応答（HTML・SVG・304）に画面用の CSP と共通のヘッダー。偽の `ASSETS` が弱い CSP や `Cache-Control` を付けて返しても、コードの値で上書きされる（偽物はヘッダーを変えられない応答を返し、作り直しを確かめる）。API の応答に共通のヘッダーと `default-src 'none'` の CSP。API の経路が付けたヘッダー（T-08 の画像の CSP・`Cache-Control`）は上書きしない。`/sw.js` と HTML は `Cache-Control: no-cache`（偽の `ASSETS` が `Cache-Control: public, max-age=...` を返しても）。HEAD と405の応答にも共通のヘッダー。identity の callback が付けた `Referrer-Policy` を上書きしない。E2E のエントリ（`createWorker` を共有）の API の応答にもヘッダーが付く。
- [x] Apple を止める：`APPLE_LOGIN_ENABLED` が `"0"`・未設定・ほかの値なら、`start` は `/login?error=login_failed` への303で、`oauth_transactions` を書かず、新しい結びつけ Cookie を発行しない（`loginFailed` と同じく、消す `Set-Cookie` だけが出る）。`callback` は本文を読まずに problem+json の404。回数の上限（`auth_start`）は Apple を止めても先に効く（既存の rateLimit のテストが通る）。application の `startLogin`・`handleCallback` も Apple なら失敗を返す。`"1"` なら今までどおり（既存のテストが通る）。
- [x] Web：`VITE_APPLE_LOGIN_ENABLED` がないとき、ログインの画面と招待の画面に「Appleでログイン」が出ない。`"1"` なら出る。
### CI の検査（実装PRで足す）
- [x] ビルドと設定：`build:prod` のあと、`apps/web/dist/index.html` があり、インラインの script・style・E2E 用の名前・`Appleでログイン`・`_headers`・`_redirects` がない。wrangler の設定の項目（上の「ビルドとデプロイのコマンド」の一覧）が仕様のとおり。

### E2Eテスト（対象にする利用者の流れ）
- [x] 既存の E2E がすべて通る（ローカルの開発と E2E は `VITE_APPLE_LOGIN_ENABLED=1`・`APPLE_LOGIN_ENABLED=1` で、今の流れのまま）。
- [x] 本番と同じ形（ビルドした画面を静的アセットとして同じ Worker から出す）で、ログインの画面と SPA の経路（`/invites/xxx`）と招待リンクの受け口（`/invite`。未ログインでも `InvitePage` を描画する）を開くと、画面が出て、CSP の違反が0件で、画面用の CSP と共通のヘッダーが付く。
  - wrangler に、ローカルでだけ使う環境 `assets`（`main` は本番と同じ `src/index.ts`、`assets` は prod と同じ設定、vars は e2e と同じ形）を足し、Playwright の別の project（`release`）で `wrangler dev --env assets` に向けて開く。ローカルの D1 は `database_id` ごとに分かれるので、assets の `database_id` は e2e と別の仮の値にする（同時に起動する E2E とデータを共有しない）。秘密は `scripts/write-e2e-dev-vars.mjs .dev.vars.assets` で別のファイルに生成する。ログインはしない（テスト用ログインの経路を本番のエントリに入れないため）。
  - CSP の違反は `securitypolicyviolation` のイベントとコンソールで数える。
- カスタムドメインと `workers.dev` を閉じたことは本番でしか確かめられないので、「人が行う作業」の9で確かめる。

## スコープ外
- `wrangler deploy`・`terraform apply`・secret・Google と Resend の管理画面の設定（人が行う）。
- アプリストアへの公開、Apple のログイン、Apple カレンダー（T-09）。
- WAF・ボット対策・エッジのレート制限（#42 の残り）。
- 退会（#37）、古いデータの掃除（#38）、初回設定（#43）、画面のデザイン（T-11）。
- Google の審査（一般公開のとき、または連携する人が100人に近づいたときに行う）。

## 決定事項（仕様書PR pryusei/kokohima-app#83 のマージで合意）
1. 最初のリリースは、友達だけに向けた Web アプリ。ログインは Google だけ（利用者と決めた）。
2. ドメインは `kokohima.app`（利用者が取得済み）。画面と API を同じ Worker・同じオリジンから出す。
3. セキュリティのヘッダーは `_headers` ファイルでなく、Worker のコードで付ける（公式の資料で確かめられなかったことに頼らず、テストで確かめられる形にする）。そのため `run_worker_first: true` にする。
4. Apple は設定値で止め、コードは残す（あとで戻せるように）。
5. 最初のリリースは prod だけにし、staging は作らない（利用者と決めた）。
6. カスタムドメインの DNS の記録は、Workers（`custom_domain: true`）が作り、管理する。Terraform の DNS の管理（infra/README.md）の例外として README に書く。Resend の記録などほかの DNS の記録は Terraform で持つ。
7. Google の OAuth の公開ステータスは、審査を受けずに「本番」にする（友達をテストユーザーに1人ずつ足す手間と、カレンダーの連携が7日ごとに切れることをなくす。利用者と決めた）。カレンダーの連携で出る確認されていないアプリの警告と、連携できる人数の上限（100人）は受け入れる。一般公開の前に審査を受ける。

## 確認事項（解消済み）
- 決定事項2〜4・6・7と、送信のメールアドレス `notify@kokohima.app` は、仕様書PRのマージで合意した。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-21 | 初版 | 友達向けの最初のリリース（利用者と決めた） |
| 2026-11-21 | staging を作らないことにした。セキュリティのレビューを反映：画面の応答のヘッダーは常に上書き、CSP は画面の側の全応答に、振り分けの端の場合、wrangler の設定の CI の検査、トップレベルの `workers_dev: false`、Apple の判定の位置、`VITE_APPLE_LOGIN_ENABLED` の置き場、`VAPID_SUBJECT`、ゾーンの設定・鍵・Google の「テスト」の制約・デプロイのあとの確認と戻し方 | 利用者の回答、仕様書PRのレビュー（セキュリティ） |
| 2026-11-21 | 仕様のレビューを反映：Apple を止めた `start`・`callback` の応答の形と順番、設定値の置き場（vars・vitest・`.env.development`）、`NOTIFICATION_START_AT` は `"1"`、転記の PR の順番、API トークンの分け方・有料プラン・Terraform の初回・Google Calendar API・Resend の DNS を Terraform で、本番と同じ形の画面の CSP の E2E、`db:migrate:prod`、実装PRで直す文書の追加、決定事項6・7 | 仕様書PRのレビュー（仕様） |
| 2026-11-21 | Apple を止めた `start` は消す `Set-Cookie` だけを出す（`loginFailed` と同じ）、止めていることは隠さない、画面の `Cache-Control` は `/sw.js` と HTML だけ上書き、`.gitignore` の例外 | 仕様書PRのレビュー（pryusei/kokohima-app#83） |
| 2026-11-21 | 実装した。Zod の `jitless`（CSP の `eval` の違反を出さない）を足し、決定事項と確認事項を合意済みにした | 実装PR |
| 2026-11-21 | 実装PRのレビューを反映：`assets` を書く環境、`Content-Type` のない応答は304だけ HTML とみなす、wrangler の設定の検査の項目、`db:migrate:prod` のコマンド | 実装PRのレビュー（仕様） |
| 2026-11-21 | 実装PRのセキュリティのレビューを反映：deploy:prod でも API のビルドの E2E の名前と `main` を検査、どの環境も workers.dev を開けない検査、Apple のボタンは目印 `data-provider="apple-login"` で検査 | 実装PRのレビュー（セキュリティ） |
| 2026-11-22 | 実装PRのレビューを反映：deploy:prod だけで転記を忘れた値を検査（`--deploy`）、`ASSETS` がないときの API のヘッダーの扱い、デプロイのあとの `//` のパスの確認、本番と同じ形の E2E に `/invite`、assets の環境のローカルの D1 を e2e と分ける | 実装PRのレビュー |
| 2026-11-23 | 決定事項7を変えた：Google の OAuth を審査なしで「本番」の公開ステータスにする（テストユーザーの登録と7日の失効をなくす）。人が行う作業3と概要を合わせた | 利用者の回答（最初のリリースのあと） |
