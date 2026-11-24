# T-32 仕様書：LINE ログイン

- 状態：実装済み
- タスク票：docs/tasks/T-32-line-login.md
- 関係する要件：F-01 認証、F-03 通知、F-22 問い合わせ、NF-04。pryusei/kokohima-app#180（親 #178）
- 進め方：持ち主の決定で、仕様書と実装を同じ PR にする（1タスク2PRの例外）

## 概要
- 招待は LINE で届き、LINE の中のブラウザで開かれる。Google はアプリに埋め込まれたブラウザからのログインを断るので、そこで止まる人が出る（T-28 の開き直しの帯）。
- LINE ログイン（OpenID Connect、通常のチャネル）を identity に足し、ログインの画面と招待の受け口で最初のボタンにする。Google は残す。
- LINE からはメールアドレスも名前も受け取らない。メールアドレスがない人でも、通知・新しい端末のログインの知らせ・問い合わせが成り立つようにする（送れないものは送らず、アプリの中に残す）。
- Google と LINE で登録した人は別の利用者になる（統合しない。#45）。

## 決めたこと
持ち主の決定（1・5）と、この仕様書で推奨として決めたもの（2〜4・6〜9。PR の「判断してほしいこと」に書いた。返事がなければこのとおり）。

1. LINE ログインは通常のチャネル（LINE Developers の「LINEログイン」チャネル、アプリの種類は「ウェブアプリ」）で作る。LINE ミニアプリは保留（通常のチャネルで作った LIFF は、あとからミニアプリのチャネルに移せない。今回は LIFF を使わない）。
2. scope は `openid` だけにする。`email` は申請しない（申請に審査があり、利用者も断れるため、ない前提で作る）。`profile` も求めない。表示名とアイコンは LINE から取らず、今の名前の画面（T-31）とアイコンの設定（T-27）に任せる。
   - 理由：預かる情報を増やさない（プライバシー ポリシーに LINE の名前・写真を書かずに済む）。名前の画面はすでに必須で、1回入れるだけで済む。LINE の名前は本名のことが多く、友達以外にも出る招待の受け口に出したくない。
3. IDトークンは LINE の検証のエンドポイント（`POST https://api.line.me/oauth2/v2.1/verify`）で確かめる。JWKS（ES256）での自前の検証はしない。
   - 理由：LINE の IDトークンの署名には、チャネルシークレットの HS256 と ES256（JWKS）の2つの方式がある。方式を決め打ちすると、LINE 側で方式が変わったときに全員がログインできなくなる。verify は方式によらず確かめられる。実装の前に、持ち主が LINE の公式の資料（「IDトークンを検証する」）で、ウェブアプリのログインの方式を確かめる必要もなくなる。
   - IDトークンはトークンのエンドポイントから TLS で直接受け取ったものだけを使う（OIDC Core 3.1.3.7 の、直接受け取ったトークンの扱い）。verify の応答も、こちらで発行者・宛先・期限・nonce・sub を確かめ直す（Google・Apple と同じ水準）。
   - 受け入れること：ログインのたびに LINE へもう1回問い合わせる（数十ミリ秒）。verify に届かないときはログインの失敗にする。
4. LINE ログインは、チャネル ID とチャネルシークレットの両方が `wrangler secret` に入っているときだけ動く。どちらかがなければ、Apple を止めたとき（T-12）と同じく、開始はログインの失敗の画面へ戻し、コールバックも失敗にする。画面のボタンは常に出す（ビルドの変数で切り替えない）。
   - そのため、持ち主の作業（「持ち主の作業」の1〜5）をマージ・デプロイの前に済ませる。済ませないままデプロイすると、LINE のボタンを押した人はログインの失敗の画面に戻る（Google では入れる）。
5. Google と LINE は別の利用者（#45）。同じ人が両方で入ると、友達・ここ暇などは別々になる。統合の機能は作らない。利用規約の第3条に1行足す。
6. メールアドレスがない人の通知（T-07）：送り先の決め方は変えない。
   - 新しい端末でのログイン：メールだけで送る決まりのまま。メールアドレスがなければ送らず（`outcome = 'no_address'`）、お知らせ一覧にだけ残す。プッシュには切り替えない（T-07 決定事項3 の「新端末のログインだけはメール」のまま。上限の組と数え方もメールで決まっているので、プッシュで知らせるなら T-07 を直す別のタスクにする）。
   - ほかの種類：今のとおり、プッシュの購読があればプッシュ、なければメール。メールアドレスがなければ送らず、お知らせ一覧に残す。
   - 画面：通知の設定の注記に、LINE でログインした人はお知らせ一覧にだけ残ることを書く。
7. 問い合わせ（T-24）：メールアドレスがない人は、返事が要るとき返信先のメールアドレスを内容に書く。Slack の文の返信先は今のとおり「登録なし」。個人情報の求め（プライバシー ポリシーの12.）も、LINE の人はアプリの問い合わせから送り、内容に書いたアドレスに返す（ログインした本人の求めなので、本人の確認はセッションで行う）。
8. ボタンの色は LINE の決まり（地 `#06C755`、文字は白の太字）。`index.css` にトークン `--kh-brand-line`・`--kh-on-brand-line`（`bg-brand-line`・`text-on-brand-line`）を足す。夜のテーマでも同じ色。
   - 受け入れること：白の文字と緑の地のコントラストは 2.3:1 で、WCAG の AA（4.5:1）に届かない。LINE のボタンだと見分けられることを優先する（T-47 で見直す）。
   - 今は文字だけのボタンにし、LINE のアイコンは入れない（LINE が配る画像の扱いの決まりを持ち主が確かめてから足す）。
9. LINE の中のブラウザの帯（T-28）：LINE の中でも「LINEでログイン」は通るので、文を「LINEの中で開いています。「LINEでログイン」なら、このまま続けられます。Googleでログインするときは、ブラウザで開き直してください。」に変え、「ブラウザで開き直す」を副ボタンにする。招待リンクに付ける `openExternalBrowser=1`（T-28）は今は変えない（「確認事項」1）。

## 前提
- コンテキストは `identity`。Google・Apple と同じ `apps/api/src/identity/infra/oidc.ts` の流れ（state・nonce・PKCE・結びつけ Cookie・完了コード。T-01）に LINE を足す。
- LINE の各エンドポイントは `AppDeps.line.endpoints`（`apps/api/src/env.ts` の `LINE_ENDPOINTS`）。E2E のエントリだけが偽物に差し替える。
- 発行者 `https://access.line.me`、宛先はチャネル ID。`sub` は LINE がチャネルのプロバイダーごとに発行する利用者の ID（`U` で始まる33文字）。

## API
`api-conventions` に従う。T-01 の認証の経路と同じ扱い（コールバックは画面へのリダイレクトで失敗を伝える。理由は区別しない）。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/auth/line/start` | なし | query：`authStartQuerySchema`（`returnTo`） | 302：LINE の認可画面へ（止めた環境では303 `/login?error=login_failed`） | なし |
| GET | `/api/v1/auth/line/callback` | なし（state＋結びつけCookie） | query：`code`、`state`（または LINE の `error`） | 303：`/auth/complete#code=<完了コード>`（失敗時は `/login?error=login_failed`） | 画面へのリダイレクトのみ |

- 完了（`POST /api/v1/auth/complete`）・更新・ログアウト・`GET /me` は変えない。
- ログインの開始の回数の上限（T-10 の `auth_start`、IP ごと）は Google・Apple と同じものを使う。
- 退会のログインし直し（T-16）の `reauthProvider` に `"line"` を足す。

## データ
- マイグレーションは要らない。`user_identities.provider` に `line` が入る（列は TEXT で、値の制約はない）。`(provider, subject)` の UNIQUE はそのまま。
- `users.email` は、LINE の利用者では NULL のまま（決めたこと2）。
- `oauth_transactions.provider`・`login_codes.provider`・outbox の `SessionStarted` の `provider` にも `line` が入る。

## 振る舞い

### 1. ログインの開始（`/start`）
- T-01 の手順1〜4と同じ（`state`・`nonce`・`code_verifier`・`binding` を作り、ハッシュで保存し、結びつけ Cookie を `SameSite=Lax` で設定する。LINE は GET で戻るため）。
- 認可画面：`https://access.line.me/oauth2/v2.1/authorize` に `response_type=code`、`client_id=<チャネル ID>`、`redirect_uri=<APP_ORIGIN>/api/v1/auth/line/callback`、`state`、`nonce`、`scope=openid`、`code_challenge=<S256>`、`code_challenge_method=S256`。
- 止めた環境（チャネル ID かシークレットがない）では、何も書かず、結びつけ Cookie も発行せず、303 `/login?error=login_failed`。

### 2. コールバック
- T-01 の手順1・2（state の取り出し、プロバイダ違いの拒否、結びつけ Cookie の照合）は同じ。止めた環境では失敗にする（start のあとで止めたときも、完了コードを作らない）。
- `error` があれば失敗。

### 3. 認可コードの交換
- `POST https://api.line.me/oauth2/v2.1/token`（`application/x-www-form-urlencoded`）：`grant_type=authorization_code`、`code`、`redirect_uri`、`client_id`、`client_secret`（チャネルシークレット）、`code_verifier`。
- 応答の `id_token` だけを使う（アクセストークンは使わず、保存もしない）。ない・エラーは失敗。

### 4. IDトークンの検証（決めたこと3）
1. IDトークンが 8192 文字を超えたら失敗（外へ送る前に長さを抑える）。
2. `POST https://api.line.me/oauth2/v2.1/verify`：`id_token`、`client_id`（チャネル ID）、`nonce`（保存した値）。LINE が署名・宛先・期限・nonce を確かめる。200 以外（400・5xx）・届かないときは失敗。
3. 応答をこちらでも確かめる（`apps/api/src/identity/domain/lineIdToken.ts` の `checkLineClaims`）：
   - `iss` が `https://access.line.me` と一致
   - `aud` が文字列で、チャネル ID と一致（配列は受け付けない）
   - `exp`・`iat` が数で、許容誤差60秒（`exp + 60 > 今`、`iat - 60 ≦ 今`）
   - `nonce` が文字列で、保存した値と定数時間比較で一致
   - `sub` が1〜255文字の文字列
4. 応答に `email`・`name`・`picture` があっても使わない（`verifiedEmail` は LINE ではいつも null）。

### 5. 利用者とセッション
- T-01 の手順5〜7と同じ。`(line, sub)` で探し、なければ作る（メールアドレスは null）。完了コード → `/auth/complete` → セッション。
- `SessionStarted` の `provider` は `line`。新しい端末のログインの判定（`hasEarlierSession`）は方法によらない。
- Google と LINE で同じ値の `sub` が来ても、`provider` が違うので別の利用者になる。

### 6. 画面
- ボタンの並び（ログインの画面 `/login` と、招待の受け口 `/invite` の未ログインのとき。共通の部品 `apps/web/src/auth/LoginButtons.tsx`）：
  1. 「LINEでログイン」（`Button` の variant `line`：地 `bg-brand-line`、文字 `text-on-brand-line`。決めたこと8）
  2. 「Googleでログイン」（副ボタン。今のまま）
  3. 「Appleでログイン」（`Button` の variant `apple`：地 `bg-ink`、文字 `text-surface`。`VITE_APPLE_LOGIN_ENABLED` が `"1"` のときだけ。T-12）
- 色は variant の中だけで決め、副ボタン（`secondary`）のクラスに色のクラスを足して上書きしない。Tailwind v4 は同じ性質のクラスをクラス名の順に出すので、足したほうが勝つとは限らない（副ボタンの `bg-surface` が勝ち、白の地に白の文字になった。T-11「共通の部品」）。
- 行き先は `/api/v1/auth/<provider>/start?returnTo=<returnTo>`（受け口は `/invite`）。
- LINE の中のブラウザの帯（T-28）：文と副ボタン（決めたこと9）。出す条件は変えない。
- 退会のログインし直しで `reauthProvider` が `"line"` なら、`/api/v1/auth/line/start?returnTo=...` へ移る。
- 通知の設定：
  - プッシュが使えない端末の注記：「ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます（LINEでログインした人はメールアドレスがないので、お知らせ一覧にだけ残ります）」
  - 新しい端末のログインの注記：「新しい端末でのログインのお知らせは止められません（メールで届きます。LINEでログインした人には、お知らせ一覧にだけ出します）」
- 問い合わせ（決めたこと7）：上の説明に「LINEでログインしているときはメールアドレスがないので、返事が要るものは、返信先のメールアドレスを内容に書いてください。」、個人情報の求めの注記に「（LINEでログインしているときは、この画面から送った求めに書いたメールアドレスにお送りします）」を足す。

### 7. プライバシー ポリシーと利用規約（T-19「9.」）
- 預かる情報（LINE の識別子）と、取り扱いを任せる事業者（LINEヤフー株式会社）が増えるので、同じ PR で本文を直す。本格稼働までは予告なしで改定する（T-19 決めたこと17）。改定日（効力が生じる日）は今の `2026年11月24日`（T-33 と同じ日。マージしてデプロイする日がずれたら `legal.ts` の日付だけを直す）。予告の行と「この改定で変わるところ」は `null` のまま。
- プライバシー ポリシー：
  - 2.「ログインで受け取るもの」：Google の人（識別子と確認済みのメールアドレス）と LINE の人（識別子だけ。メールアドレスは受け取らない）に分ける。名前・写真・パスワードに加え、LINE の友だちとトークも受け取らないと書く。
  - 2.「問い合わせ」：メールアドレスは LINE の人にはないと書く。
  - 3. 目的の5：新しい端末のログインは、メールアドレスがない人にはお知らせ一覧にだけ出す。
  - 5. 委託：「LINEヤフー株式会社（日本）」（任せること：LINE でのログイン。渡すもの：ログインの手続き。LINE から受け取ったログインの確認の結果を LINE に問い合わせて確かめることを含む）。日本の事業者なので 7.（外国）には入れない。
  - 8. 保存する期間：アカウントの識別子を「Google と LINE の識別子」にする。
  - 12. 求め方：LINE の人はアプリの問い合わせから求め、答えは求めの内容に書いたメールアドレスに送る。
- 利用規約 第3条1：「Google アカウントか LINE アカウントでログインして使います。Google と LINE でログインすると別のアカウントになり、あとから1つにまとめられません。」

### 8. 設定値
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `LINE_CHANNEL_ID` | secret | LINE ログインのチャネル ID（持ち主の決定で secret にする。認可画面の URL には出る） |
| `LINE_CHANNEL_SECRET` | secret | チャネルシークレット。トークンのエンドポイントにだけ送る。ログ・エラー・画面に出さない |

- 両方がそろっているときだけ LINE ログインが動く（決めたこと4）。ローカルは `.dev.vars`（コミットしない。ひな形は `apps/api/dev-vars.example`）、単体テストは `vitest.config.ts` の偽の値、E2E は `scripts/write-e2e-dev-vars.mjs` が偽の値を書く。

### 9. E2E用の偽の LINE
- E2E のエントリ（`src/e2e/entry.ts`）だけが `line.endpoints` を偽物に向ける（`src/e2e/line.ts`）。
  - 認可画面：`http://localhost:8787/__e2e__/line/authorize`。`redirect_uri` が `APP_ORIGIN` の下で、`state`・`nonce` があり、`code_challenge_method=S256` のときだけ、同意したことにしてコールバックへ302で戻す。利用者（`sub`）は毎回新しく作る。`E2E_MODE=1` のときだけ（ほかの `/__e2e__` と同じ）。
  - トークン・verify：`https://line.e2e.invalid/oauth2/v2.1/{token,verify}`。verify はチャネル ID と nonce が合うときだけ 200。
- 本番のビルドに `__e2e__` を含めない決まり（T-01）はそのまま。

### 10. 持ち主の作業（マージ・デプロイの前に。決めたこと4）
1. LINE Developers（https://developers.line.biz/console/）で、プロバイダー（例：「ここ暇」）を作り、「LINEログイン」のチャネルを作る。
   - チャネルの種類：LINEログイン。地域：日本。アプリの種類：「ウェブアプリ」。
   - チャネル名・説明・アイコン：同意の画面に出る（「ここ暇」とアプリのアイコン）。
   - プライバシーポリシーの URL：`https://kokohima.app/privacy`、利用規約の URL：`https://kokohima.app/terms`。
   - メールアドレスの取得の権限（OpenID Connect の「メールアドレス取得権限」）は申請しない（決めたこと2）。
2. 「LINEログイン設定」の「コールバックURL」に `https://kokohima.app/api/v1/auth/line/callback` を登録する（ローカルで確かめるなら、開発用の別のチャネルに `http://localhost:5173/api/v1/auth/line/callback`）。
3. チャネルを「公開済み」にする（「開発中」のままでは、チャネルの管理者と開発者として登録した人しかログインできない）。
4. 「チャネル基本設定」のチャネル ID とチャネルシークレットを、本番に入れる（値はチャットやファイルに貼らない）：
   - `pnpm --filter api exec wrangler secret put LINE_CHANNEL_ID --env prod`
   - `pnpm --filter api exec wrangler secret put LINE_CHANNEL_SECRET --env prod`
5. デプロイのあと、iPhone と Android の実機で確かめる（「確認事項」2・3）：LINE のトークから招待リンクを開く → 「LINEでログイン」→ 名前の画面 → 友達になる。外のブラウザ（Safari・Chrome）でも「LINEでログイン」で入れること。
- チャネルシークレットを作り直したら、4. の2行めをやり直す。止めたいときは `wrangler secret delete LINE_CHANNEL_SECRET --env prod`（ボタンを押した人はログインの失敗の画面に戻る）。

## 認可と秘匿
- 閲覧者IDの使い方：変えない。閲覧者は `requireAuth` が検証した JWT の `sub` からだけ得る。LINE の `sub` は `user_identities` の照合にだけ使い、画面や API の応答に出さない。
- 他人のデータに届かないことの保証：このタスクで他人のデータを返す API はない。LINE の利用者のトークンでも、`GET /me` は閲覧者本人の行だけを返す（query の ID は無視する）。テストで確かめる。
- 区別させない応答：コールバックの失敗は、理由（キャンセル・state・結びつけ・トークン・verify・各クレーム・止めた環境・退会）によらず `error=login_failed`。止めた環境の開始も同じ。
- 秘密情報：チャネルシークレット・認可コード・IDトークン・nonce をログ・エラー・画面に出さない。ログは `{ event: "login_failed", provider: "line", reason }` だけ。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 開始：LINE の認可画面へ、`scope=openid`・state・nonce・PKCE（S256）・`redirect_uri`・チャネル ID つきで送る。結びつけ Cookie は `SameSite=Lax`。チャネルシークレットを URL に出さない
- [x] 正常系：初回は利用者と対応づけ（`provider=line`）を作り、2回目は同じ利用者。`users.email` は null。IDトークンにメールアドレスがあっても保存しない
- [x] トークンのエンドポイントに `code_verifier`・チャネル ID・シークレット・`redirect_uri` を送り、verify に IDトークン・チャネル ID・nonce を送る
- [x] Google と LINE で同じ `sub` でも別の利用者になる
- [x] `SessionStarted` の `provider` は `line`
- [x] 拒否：verify が 400（署名不正）・5xx・届かない、発行者違い、宛先違い・配列、期限切れ（60秒を過ぎた）、nonce の不一致・欠落、`sub` の欠落・256文字以上、トークンのエンドポイントのエラー・IDトークンなし、LINE の `error`、Google で始めた state、結びつけ Cookie の欠落・不一致、verify の応答の nonce が違う。どれも完了コードもセッションも作らない
- [x] ログに失敗の種類だけを出し、IDトークン・認可コードを出さない
- [x] 止めた環境：チャネル ID かシークレットがなければ使えない。開始は何も書かずに失敗へ。始めたあとで止めても、コールバックは失敗（verify も呼ばない）
- [x] `checkLineClaims` の境界（期限・iat の60秒、形の違い）
- [x] 他人のIDでは取得できない：LINE の利用者のトークンで `GET /me?id=<他人>` を開いても本人だけが返る
- [x] 退会のログインし直しの `reauthProvider` が `line`。画面は LINE のログインし直しへ移る
- [x] 通知：メールアドレスのない利用者の新しい端末のログインは `no_address` で、メール・プッシュを送らず、お知らせ一覧に残る。ほかの種類は購読があればプッシュ、なければ `no_address`
- [x] E2E の偽の LINE：開始から完了まで通る。認可画面は `E2E_MODE=1` のときだけで、`APP_ORIGIN` の外へ戻さない。verify はチャネル ID・nonce が違えば 400
- [x] 画面：ログインの画面と受け口で LINE が最初、Google が次（Apple を出す設定でも LINE が最初）。行き先と `returnTo`。色はトークン。LINE と Apple のボタンに副ボタンの色のクラス（`bg-surface`・`text-ink`・`border-line-strong`）が混ざらない。LINE の中のブラウザの帯の文と副ボタン
- [x] プライバシー ポリシー・利用規約の本文（2.・3.・5.・7.・8.・12.・第3条）

### E2Eテスト（対象にする利用者の流れ）
- [x] ログイン画面の最初のボタンは「LINEでログイン」。押すと（偽の LINE）名前の画面になり、決めると「みんな」が開き、再読み込みしても続く。描かれた色が地 `rgb(6, 199, 85)`・文字 `rgb(255, 255, 255)`（`e2e/auth.spec.ts`。`mobile` のプロジェクトだけ。偽の認可画面が `:8787` の API にあるため `@iphone` にしない）
- [x] LINE の中のブラウザで招待リンクを開くと、「LINEでログイン」が最初に出る（`e2e/friends.spec.ts` の T-28 の流れに足す）
- 本物の LINE でのログインは対象外（`e2e-testing` スキル）。持ち主が実機で確かめる（「持ち主の作業」5）

## スコープ外
- アカウントの統合（Google と LINE。#45）
- LINE の名前・アイコンの取り込み、メールアドレスの取得（決めたこと2）
- LIFF・LINE ミニアプリ、LINE の公式アカウントとの友だち追加（`bot_prompt`）、LINE でのお知らせ（Messaging API）
- 招待リンクの `openExternalBrowser=1` をやめること（「確認事項」1）
- LINE のアイコン入りのボタン（決めたこと8）

## 確認事項（実装のあとに持ち主が確かめる）
1. LINE ログインが通るなら、招待リンクに付けている `openExternalBrowser=1`（T-28）をやめて、LINE の中のまま受け口からログインさせるほうがよいか。実機で LINE の中のログインと Cookie（`__Host-`）の保ち方を確かめてから、別のタスクで決める。
2. LINE・インスタの中のブラウザで、外に出ずにログインが通るか（iPhone・Android の実機）。インスタの中では LINE アプリへの切り替え（自動ログイン）が起きるかも確かめる。
3. 更新用トークンの Cookie（`__Host-`）が、LINE の中のブラウザで閉じたあとも保たれるか（保たれなければ、開くたびにログインし直しになる）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-24 | 初版（仕様書と実装を同じ PR にした） | pryusei/kokohima-app#180 |
| 2026-11-24 | LINE と Apple のボタンの色を `Button` の variant（`line`・`apple`）にした。副ボタンのクラスに色を足す書き方では、Tailwind v4 のクラスの順で副ボタンの白が勝ち、白の地に白の文字になっていた。単体テストに副ボタンの色のクラスが混ざらないこと、E2E に描かれた色を足した | 実装PRのレビュー（pryusei/kokohima-app#212） |
