# T-44 仕様書：ログインなしで読める紹介のページ

- 状態：実装済み（実装PR pryusei/kokohima-app#222。仕様書PR pryusei/kokohima-app#219。マージ前なので、台帳 docs/tasks/REGISTRY.md では「作業中」）
- タスク票：docs/tasks/T-44-landing.md
- 関係する要件：要求定義書「残りの論点」（Google の審査）、T-12 人が行う作業3（同意画面のブランディング）、T-19 決めたこと10（ホームページは審査のときに見直す）・決めたこと17（本格稼働までは予告なしで改定）。issue pryusei/kokohima-app#192・#199（親 #178）

## 概要
Google の OAuth の審査（#199。使うスコープはすべて機微でないので、受けるのはブランドの確認だけ）では、同意画面の「アプリのホームページ」が、ログインなしで読めて、アプリの働きの説明とプライバシー ポリシーへのリンクを持ち、アプリ名が同意画面と同じであることが求められる。今の `https://kokohima.app/` は未ログインだと `/login` へ移り、HTML は空の `<div id="root">` だけなので、この要件を満たさない。そこで、審査に足りる最小の紹介のページを、JavaScript を使わない静的な HTML として作り、未ログインで `/` を開いた人に出す。ログインしている人には、今までどおりアプリ（みんな）を出す。あわせて、プライバシー ポリシーの「11. Google から受け取った情報の扱い」に、審査をする人が読める英語の段落を足す（T-19 の改定。予告なし）。

## 決めたこと
1. **範囲は審査に足りる最小**：見出し・短い説明・3つの約束・ログインへの入口・プライバシー ポリシーと利用規約へのリンクだけにする。#192 のほかの案（動く見本、安全とよくある質問の節、「LINE で始める」を主ボタンにすること、`?src=` の数え方、インスタ向けの見せ方）はスコープ外（あとで）。
2. **JavaScript なしの静的な HTML**：紹介のページは `apps/web/landing.html` に書き、vite のビルドの入口に足して `dist/landing.html` を作る。`<script>` は1つも置かない（外のファイルも読まない）。見た目は `apps/web/src/index.css` のトークンを使う CSS を1つ、`<link rel="stylesheet">` で読む。
3. **振り分けは Worker で、ログインの Cookie の有無だけを見る**：`GET`・`HEAD` の `/`（クエリは問わない）で、要求に更新用トークンの Cookie（`__Host-kh_rt`。T-01）があれば今までどおり SPA の `index.html`、なければ紹介のページを返す。Cookie の中身は確かめない（D1 を読まない。無効な Cookie なら SPA が今までどおり `/login` へ移す）。
4. **アプリ名は「ここ暇」**：`<title>`・見出し（`<h1>`）・`apple-mobile-web-app-title` を、同意画面のアプリ名と同じ「ここ暇」にする。英字の名前は添えない（同意画面にも添えないため）。
5. **ログインへの入口は `/login` へのリンク1つ**：文言は「はじめる・ログイン」。ログイン済みの人が押しても、`/login` がみんなへ移す（今の SPA の振る舞い）。
6. **プライバシー ポリシーの 11. に英語の段落を足す**：限定使用（Limited Use）の公式の英文と、空き／埋まりだけを読むこと・書き込みは「ここ暇」カレンダーだけであることの数行（文案は「7.」）。T-19 決めたこと5（英語版は作らない）の例外とし（T-19 決めたこと18。この PR で T-19 の仕様書の決めたこと5・10・18、6節の11.の文案、スコープ外、（b）9 を直した）、ページ全体の英語版は作らない。改定日は、この実装PRをマージしてデプロイする日にし、予告はしない（T-19 決めたこと17）。
7. **PWA の `start_url` は `/` のまま**：ホーム画面から開くと、ログイン済みなら Cookie が届くのでアプリが開く。ログインが切れていたら紹介のページが出て、「はじめる・ログイン」から入り直す。
8. **連絡先は運営の問い合わせ先 `ops@kokohima.app`**（T-19 決めたこと2）。個人の名前・アドレスは書かない。
9. **解析・追跡はしない**：紹介のページに解析のスクリプト・ピクセル・外のフォントや画像を入れない。Worker も `/` の要求を数えたり記録したりしない。

## 前提
- 審査の要件（2026-11-24 に Google の公式の資料で確かめた。#199 の準備の資料）：
  - 同意画面に登録したスコープ（`openid`・`userinfo.email`・`userinfo.profile`・`calendar.app.created`・`calendar.freebusy`）は、Google Cloud Console の表示ですべて「機微でない」（2026-11-24 に持ち主が確かめた）。アプリが要求するのは `openid email` と、カレンダーの2つだけ（`userinfo.profile` は要求しないので、同意画面の「データアクセス」から外す。T-12 人が行う作業3）。機微なスコープの確認（動画など）は要らず、ユーザー数の上限も当たらない。受けるのはブランドの確認だけ。
  - ブランドの確認：ホームページがログインなしで読める、アプリの働きを説明している、プライバシー ポリシーへのリンクがある、アプリ名が同意画面と同じ、ホームページ・ポリシー・リダイレクト URI のドメインが承認済みのドメイン（Search Console で確認済み）である。
  - 機微なスコープの確認（機微なスコープを足すときに要る。今は要らない）：ポリシーが Google のユーザーデータの扱い（何を読み、何に使い、誰に渡すか）を開示している。言語の指定は見つからなかったが、審査をする人は英語で読むことが多い。英語の段落（「7.」）は、ブランドの確認でもポリシーの中身を読みやすくするために置く。
- `run_worker_first: true`（T-12）なので、`/` の要求は Worker のコードを通る。`__Host-kh_rt` は `Path=/`・`SameSite=Strict`・`HttpOnly`（`apps/api/src/identity/cookies.ts`）なので、同じサイトの移動・アドレスの直接の入力・再読み込み・ホーム画面からの起動では `/` に届き、ほかのサイトのリンクから来たときは届かない。
- Service Worker（`apps/web/public/sw.js`）は `fetch` を扱わず、キャッシュもしないので、振り分けに影響しない。

## API
- 経路の追加・変更はない（`/api/` は変えない）。
- 変わるのは画面の側の `GET`・`HEAD` の `/` の応答だけ（下の「1.」）。

## データ
- 変更なし（マイグレーションなし）。Cookie・ストレージに新しく置くものもない。

## 振る舞い

### 1. 振り分け（`apps/api/src/worker.ts`）
- `routeRequest` の画面の側（`ASSETS` があり、`GET`・`HEAD`）で、`URL.pathname === "/"` のときだけ、次のとおりにする。ほかのパス（`/login`・`/invite`・`/invites/…`・`/privacy` など）は今までどおり。
  - 要求の `Cookie` ヘッダーに名前が `__Host-kh_rt` で値が空でない Cookie がある：今までどおり `ASSETS.fetch(request)`（SPA の `index.html`）。
  - ない：`ASSETS.fetch` に、同じ要求のパスを `/landing` に変えたもの（メソッドとヘッダーはそのまま）を渡し、その応答を返す（`html_handling` の既定で `/landing.html` は `/landing` にリダイレクトされるため、`/landing` で取る）。
  - どちらの応答にも `Vary` に `Cookie` を追加する（同じ URL で Cookie によって中身が変わるため）。`headers.append` で足し、`ASSETS` の応答のもとの `Vary`（`Accept-Encoding` など）は残す。セキュリティのヘッダーと `Cache-Control: no-cache` は、今の `withPageHeaders` のまま（HTML なので no-cache）。
- Cookie の名前は `apps/api/src/identity/cookies.ts` から `REFRESH_COOKIE_NAME`（`__Host-kh_rt`）として出し、Worker はそれを使う（名前を2か所に書かない）。Cookie の値は読まず、ログにも出さない。
- `/landing` を直接開いても紹介のページが出る（ログインの状態によらない。害がないので塞がない）。リンクや同意画面には `/landing` を書かず、いつも `https://kokohima.app/` を使う。
- `ASSETS` がない環境（ローカルの開発・E2E の `--env e2e`・単体テスト）は今までどおり。vite の開発のサーバーでは `/landing.html` で紹介のページを見られる。

### 2. 開いた場面ごとの振る舞い

| 場面 | Cookie が届くか | 出るもの |
| --- | --- | --- |
| 未ログインで `https://kokohima.app/` を開く（検索・審査の人・SNS のリンク） | ない | 紹介のページ |
| ログイン済みで、アドレスの入力・ブックマーク・再読み込みで `/` を開く | 届く | アプリ（みんな）。今までどおり |
| ログイン済みで、ほかのサイト（SNS・LINE のトークなど）のリンクから `/` を開く | 届かない（`SameSite=Strict`） | 紹介のページ。「はじめる・ログイン」を押すと、同じサイトの移動になるので Cookie が届き、`/login` からみんなへ移る（1回押す手間を受け入れる） |
| アプリの中でタブの「みんな」に戻る（SPA の移動） | 要求なし | アプリ。今までどおり |
| ログアウトした直後 | 消えている | SPA が今までどおり `/login` を出す。そのあと `/` を開き直すと紹介のページ |
| Cookie はあるが無効（失効・別の端末で「すべての端末からログアウト」） | 届く | SPA。今までどおり `/login` へ移る |
| ホーム画面から開く（PWA。T-25。`start_url` は `/`） | 届く（ほかのサイトからの移動ではない） | ログイン済みならアプリ。切れていたら紹介のページ（決めたこと7） |
| 招待リンク（`/invite?openExternalBrowser=1#t=…`。T-02・T-28） | 関係ない | 今までどおり招待の受け口（`/` ではないので振り分けない） |
| LINE の中のブラウザで `/` を開く（T-28） | 届かない（LINE の中は別の Cookie） | 紹介のページ。「はじめる・ログイン」の先の `/login` で、今までどおり T-28 の開き直しの帯が出る |
| 通知を押して開く（`/notifications`。T-07） | 関係ない | 今までどおり |

- SPA（`apps/web/src/App.tsx`）は変えない。未ログインの SPA が `/` を描くのは Cookie が無効なときだけで、今までどおり `/login` へ移す。
- `apps/web/public/manifest.webmanifest` は変えない（`id`・`start_url`・`scope` は `/` のまま）。

### 3. 紹介のページの HTML（`apps/web/landing.html`）
- `<!doctype html>`・`<html lang="ja">`・`<meta charset="UTF-8">`・`<meta name="viewport" content="width=device-width, initial-scale=1.0">`。
- `<title>ここ暇</title>`、`<meta name="description" content="友達を誘う気まずさをなくす、友達どうしのアプリ。誘っていい時間を先に置いておくと、友達がそこに誘えます。">`。
- アイコン・テーマの色は `index.html` と同じ（`icon.svg`・`apple-touch-icon.png`・`theme-color` の2つ・`manifest`）。`manifest` を読ませるのは、紹介のページからでもホーム画面に追加できるようにするため（`start_url` が `/` なので、追加したものはアプリになる）。
- `<script>`・インラインの `style` 要素と `style` 属性を置かない（CSP の `script-src 'self'; style-src 'self'` のまま）。`<noscript>` も要らない。
- CSS は `apps/web/src/landing.css` を1つ。`index.css` のトークン（`bg-bg`・`bg-surface`・`text-ink`・`text-ink-muted`・`rounded-l` など）だけを使い、Tailwind の既定の色を書かない（CLAUDE.md の UI）。暗い表示は `index.css` の `prefers-color-scheme: dark` のトークンに従う。
- 外のオリジンのものを読まない（フォント・画像・解析）。画像は `/icon.svg` だけ（`alt=""`。見出しに名前があるため）。
- 1列。幅は `max-w-md` 相当で中央に寄せ、スマホで横にスクロールしない。リンクは押せる大きさ（高さ44px 以上）にする。

### 4. 紹介のページの文案
画面の言葉は `invitation-domain` の用語表に合わせる（ここ暇・誘い・行く／今回は難しい／この時間なら・成立・見せる／見せない）。

```html
<header>
  <img src="/icon.svg" alt="" width="64" height="64">
  <h1>ここ暇</h1>
  <p>「誘っていいよ」の時間を、先に置いておく。</p>
  <p>ここ暇は、友達を誘う気まずさをなくす、友達どうしのアプリです。</p>
</header>

<main>
  <section aria-labelledby="how">
    <h2 id="how">どう使うの？</h2>
    <ol>
      <li>誘われてもいい時間に「ここ暇」を置きます。見せる友達は自分で選べます。</li>
      <li>友達はその時間に誘えます。返事は「行く」「この時間なら」「今回は難しい」の3つだけ。理由はいりません。</li>
      <li>決まったら予定になります。Google カレンダーを連携していれば、「ここ暇」という名前のカレンダーに入ります。</li>
    </ol>
  </section>

  <section aria-labelledby="promise">
    <h2 id="promise">3つの約束</h2>
    <ul>
      <li><strong>いる場所は出しません。</strong>位置情報は使いません。</li>
      <li><strong>予定の中身は見ません。</strong>カレンダーから読むのは、空いているか埋まっているかだけ。予定の名前・場所・参加者は読みません。</li>
      <li><strong>広告はありません。</strong>広告も、アクセス解析の仕組みも入れていません。</li>
    </ul>
  </section>

  <p><a href="/login">はじめる・ログイン</a></p>
  <p>13歳以上の人が使えます。18歳未満の人は、保護者の同意を得てから使ってください。</p>
</main>

<footer>
  <ul>
    <li><a href="/privacy">プライバシー ポリシー</a></li>
    <li><a href="/terms">利用規約</a></li>
    <li>問い合わせ：<a href="mailto:ops@kokohima.app">ops@kokohima.app</a></li>
  </ul>
  <p>ここ暇 運営</p>
</footer>
```

- 実装では、上の構造に `landing.css` のクラスを付ける（文は変えない）。「はじめる・ログイン」は主ボタンの見た目（T-11 の `Button` の `primary` と同じ色のトークン）にする。
- 約束の文は、事実と合わせる：位置情報は取らない（`Permissions-Policy: geolocation=()`。エリアは利用者が書く文字）、カレンダーは空き／埋まりだけ（T-06）、広告・解析なし（T-19 本文の10.）。どれかが変わったら、同じ PR でこのページも直す（「9.」）。

### 5. ビルドとビルドの検査
- `apps/web/vite.config.ts`：`build.rollupOptions.input` に `index.html` と `landing.html` の2つを置く。`dist/landing.html` と、ハッシュ付きの CSS（`/assets/` の下。1年の immutable。T-49）ができる。`landing.css` は `index.css` を読むだけなので、ビルドでは SPA と同じ CSS のファイルを指す。
- `landing.html` の検査は `apps/api/scripts/lib/landing.mjs` の純粋な関数 `landingProblems(html: string | null): string[]`（`null` は `landing.html` がない）にし、`apps/api/scripts/check-web-dist.mjs` はファイルを読んで渡すだけにする（apps/api の Vitest は Workers のランタイムで動き、fs がないため）。確かめること：
  - `dist/landing.html` がある。
  - `landing.html` に `<script` が1つもない（`src` があっても止める）。インラインの `style` 要素・`style` 属性がない（`index.html` と同じ検査）。
  - `landing.html` に、`<title>ここ暇</title>`・`<h1` の中の「ここ暇」・`href="/privacy"`・`href="/terms"`・`href="/login"` がある。
  - 外のオリジンを指す `src`・`href`（`http://`・`https://`・`//` で始まるもの）がない。ただし `mailto:` は許す。
  - HTML のコメント（`<!--`）がない（vite は HTML を圧縮しないので、そのまま本番に出る。説明は `landing.css` の冒頭に書く）。
- 本番のビルド（`pnpm --filter api build:prod`）でこの検査が回る（今までどおり）。

### 6. Service Worker と PWA のインストール（T-25）
- `sw.js` は変えない（`fetch` を扱わないので、紹介のページとアプリのどちらもネットワークから取る）。将来 `sw.js` で `/` をキャッシュするときは、Cookie で中身が変わることを考える（この仕様書の範囲外）。
- 紹介のページはアプリの画面ではないので、T-25 の「アプリとして使う」の案内は出さない（`beforeinstallprompt` を扱う JavaScript がないため）。

### 7. プライバシー ポリシーの 11. の英語の段落（T-19 の改定）
`apps/web/src/pages/PrivacyPage.tsx` の「11. Google から受け取った情報の扱い」の今の3つの項目の下に、`<SubClause title="In English">` を足し、その中を `lang="en"` にして、次の文を出す（リンクは今の `External` の部品）。

> The Japanese text above is the authoritative version. This section summarizes how we handle Google user data.
>
> ここ暇 (Kokohima)'s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.
>
> - Sign-in: we receive only your Google account ID and email address (scopes openid and email). We use your email address only for notification emails (sent via our email provider), for important notices from us and replies to your inquiries (when you contact us, it is delivered to our support Slack as the reply address), and to verify your identity when you make a request about your personal information.
> - Google Calendar (only if you connect it): we read only free/busy times (the start and end of busy periods) on your primary calendar. We never read event titles, locations, descriptions or attendees.
> - We write only to a calendar named "ここ暇" that the app creates in your Google Calendar, and only to add, update and delete plans confirmed in the app. We never read, create or change events in any other calendar.
> - Calendar data (free/busy times and the permission to write to the "ここ暇" calendar) is used only to provide these calendar features. We do not use it for advertising, do not sell it, and do not use it to train generalized AI or machine learning models. Our staff read calendar data only with your consent, for security purposes, or to comply with the law.
> - You can disconnect Google Calendar at any time in the app (設定 → カレンダー連携). When you disconnect, we delete the stored token and the stored free/busy data (a temporary cache expires within 5 minutes). We keep only the record that you connected and the ID of the "ここ暇" calendar until you delete your account, so that reconnecting uses the same calendar. The "ここ暇" calendar and the plans already written to it stay in your Google Calendar. You can also remove access in your Google Account.

- 1文めは、Google の User Data Policy が示す限定使用の開示の文（"[App]'s use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements."）の形のまま、アプリ名を入れたもの（語順を変えない。公式の文で探しても見つかるように）。
- 使い道と運営が読む場面（4つめ）は、日本語の 11. の2・3項めと同じく「カレンダーの情報」に絞る。メールアドレスの使い道（1つめ）は、日本語の 3. の終わりの段落（5.・8.・12.）と同じことを書く。解除で消えるもの・残るもの（5つめ）は、日本語の 8. と T-06 決定事項4 と同じことを書く。「5 minutes」は `RETENTION.freeBusyCacheMinutes` から出す。
- 数行の中身は、日本語の 11. と本文の2.・3.の3と4（T-19 仕様書の6節）・T-06 と食い違わない範囲だけを書く。日本語の本文が正で、英語は同じことを書いた参考とする（上の文案の1行め）。
- `apps/web/src/pages/legal.ts` の `REVISION_DATE_LINE` を「改定日（効力が生じる日）：<この実装PRをマージしてデプロイする日>」にする（2026-11-24。T-33 の改定日と同じ日なので、値は「改定日（効力が生じる日）：2026年11月24日」のまま。デプロイの日がずれたら、`safetyStart.json` と一緒にずらす）。`REVISION_NOTICE_LINE`・`PRIVACY_REVISION_CHANGES`・`TERMS_REVISION_CHANGES` は `null` のまま（T-19 決めたこと17）。利用規約の本文は変えない。

### 8. 審査の要件との対応

| 審査の要件 | この仕様での対応 |
| --- | --- |
| ホームページがログインなしで読める | 未ログインの `/` に紹介のページ（「1.」）。JavaScript なしの HTML（「3.」） |
| ホームページがアプリの働きを説明している | 「どう使うの？」の3つの手順と「3つの約束」（「4.」）。HTML に直接書く |
| ホームページにプライバシー ポリシーへのリンクがある | 下の `/privacy` へのリンク（`/terms` も）。ビルドの検査で確かめる（「5.」） |
| アプリ名が同意画面と同じ | `<title>`・`<h1>` が「ここ暇」（決めたこと4）。ビルドの検査で確かめる |
| ホームページ・ポリシーが承認済みのドメインにある | どれも `https://kokohima.app` の下（ドメインの確認は Search Console。人の作業。スコープ外） |
| ホームページが別のサービスのページ・作りかけでない | 本番のドメインの静的な HTML。外のものを読まない（「3.」） |
| ポリシーが Google のユーザーデータの扱いを開示している | 11. の日本語（今のまま）と英語の段落（「7.」） |
| 求めるスコープが働きの説明と合う | 説明の3（カレンダーに入る）と約束の2（空き／埋まりだけ）が、`calendar.app.created`・`calendar.freebusy` の使い道と合う |

### 9. 本文とページをそろえ続ける
- 紹介のページの約束（場所・予定の中身・広告）と、プライバシー ポリシーの英語の段落は、プライバシー ポリシーの日本語の本文と同じことを言う。保存する情報・外に渡すもの・カレンダーで読むもの・書くものを変える PR では、この2つも同じ PR で直す（`.github/pull_request_template.md` の今の確認の項目に「紹介のページ（`apps/web/landing.html`）」を足す）。
- ブランドの確認の途中は、同意画面のブランディング（アプリ名・ホームページの URL）を変えられない。紹介のページの URL（`/`）と見出しのアプリ名は、確認が通るまで変えない。

## 認可と秘匿
- 閲覧者IDの使い方：使わない（紹介のページは誰にでも同じ HTML。API を呼ばない）。
- 他人のデータに届かないことの保証：紹介のページは静的なファイルで、利用者のデータを含まない。Worker は Cookie の有無だけを見て、値を読まず、D1 を読まない。
- 区別させない応答：紹介のページの中身は、Cookie の有無によらず同じ（Cookie があれば SPA を返すだけ）。Cookie の有無はその要求をした本人のブラウザにしか分からないので、ほかの人の状態は漏れない。
- 記録：Worker は `/` の振り分けでログを出さない（Cookie の名前・値・有無を含めて）。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 振り分け（`apps/api/src/worker.test.ts`。`ASSETS` は偽物）：`GET /` で Cookie がないと、`ASSETS.fetch` に `/landing` の要求が渡り、その応答が返る。`HEAD /` も同じ
- [x] 振り分け：`Cookie: __Host-kh_rt=x` があると、`ASSETS.fetch` に元の `/` の要求が渡る。ほかの Cookie（`__Host-kh_oauth` だけ、`kh_rt`（接頭辞なし）、値が空の `__Host-kh_rt=`）は「ない」と同じ
- [x] 振り分け：`/?src=x`・`/?openExternalBrowser=1` も `/` と同じ。`/login`・`/invite`・`/invites/abc`・`/privacy`・`/landing` は Cookie によらず今までどおり `ASSETS.fetch(request)`
- [x] ヘッダー：`/` の応答は、Cookie の有無どちらでも `Vary` に `Cookie`・CSP・`Cache-Control: no-cache` を持つ。`ASSETS` が `Vary: Accept-Encoding` を返しても両方が残る。`POST /` は今までどおり405
- [x] `ASSETS` がない環境では、`/` は今までどおり Hono のアプリ
- [x] ビルドの検査（`apps/api/test/landing.test.ts`。`apps/api/scripts/lib/landing.mjs` の `landingProblems` を、`effective-date.test.ts` と同じ形で呼ぶ）：`landing.html` がない・`<script` がある・`style` 属性がある・`/privacy` へのリンクがない・`<title>` が「ここ暇」でない・外のオリジンの `src` がある、のそれぞれで止まり、正しい `landing.html` で通る
- [x] プライバシー ポリシー（`apps/web/src/pages/legal.test.tsx`）：11. に `lang="en"` の節があり、限定使用の英文（公式の形のまま）と、Google の User Data Policy へのリンクがある。使い道はカレンダーの情報に絞り、解除で残るもの（5分の一時的な記録・「ここ暇」カレンダー）を書いている。改定日の行が新しい日付（今の値のまま）
- [x] 紹介のページの色（`apps/web/src/ui/colors.test.ts`）：`landing.html` に Tailwind の既定の色がない
- [x] 他人のIDでは取得できない：API を足さないので対象外（紹介のページは利用者のデータを持たない）

### E2Eテスト（対象にする利用者の流れ）
- [x] 本番と同じ形（`e2e/release.spec.ts`。`--env assets`）の表に `{ path: "/", rendered: 見出し「ここ暇」 }` を足す：JavaScript ありで、CSP の違反がなく、ヘッダーと `no-cache` が付く
- [x] 本番と同じ形：`test.use({ javaScriptEnabled: false })` の別のテストで `/` を開くと、見出し「ここ暇」、説明の3つの手順、3つの約束、「はじめる・ログイン」（`/login`）・「プライバシー ポリシー」（`/privacy`）・「利用規約」（`/terms`）のリンクが読める（CSP はこちらでは見ない。違反を数える仕組みが JavaScript で動くため）
- [x] 本番と同じ形：JavaScript ありで `/` を開いても紹介のページで、「はじめる・ログイン」を押すとログインの画面（「Googleでログイン」）が出る
- [x] 本番と同じ形：`__Host-kh_rt` の Cookie（値は偽物。`http://localhost` には `__Host-` の Cookie を置けないので、要求のヘッダーで送る）で `/` を開くと、SPA の HTML が返り（`#root` がある。`Vary` に `Cookie`）、Cookie が無効なのでログインの画面に移る（ログイン済みの人がアプリに入る道を、テスト用ログインなしで確かめる）
- [x] 本番と同じ形：紹介のページの `manifest` が SPA と同じ（`start_url`・`scope`・`id` が `/`）。ホーム画面に追加すると `/` が開く（決めたこと7）
- [x] 今の E2E（vite と `--env e2e`）の `/` の流れ（ログイン後にみんなが出る、など）は、`ASSETS` がないので変わらない。直さない

## スコープ外
- #192 のほかの案：動く見本（灯り → ここどう？ → 3つの返事）、安全（ブロック・通報）とよくある質問の節、「LINE で始める」を主ボタンにして「Google で始める」を下に置くこと、`?src=` の流入元の数え方、インスタ・TikTok 向けの見せ方（OGP の画像など）。ブランドの確認が通ったあとに、別の仕様書で足す（確認の途中はブランディングを変えないため、ページの URL と名前は変えない形で）。
- `/privacy`・`/terms` を JavaScript なしの HTML にすること（今の SPA のページはログインなしで開ける。審査で差し戻されたら別のタスクにする）。
- プライバシー ポリシー・利用規約の全体の英語版（T-19 決めたこと5のまま。11. の英語の段落だけが例外）。
- Search Console でのドメインの確認と、その TXT の記録の PR（`infra-change` スキル）、同意画面のブランディングの入力、ブランドの確認の申込み（人の作業。#199）。機微なスコープは使わないので、審査用の動画は要らない。
- ログイン済みの人をほかのサイトのリンクからでもアプリに入れること（`SameSite` の変更や、別の Cookie を足すことはしない）。
- Service Worker のキャッシュ（オフラインで開くこと）。

## 実装PRで直すもの
- この仕様書の状態と変更履歴、タスク票の受け入れ条件。`docs/tasks/REGISTRY.md` の T-44 の行を「済み」に。
- T-19（`docs/specs/T-19-privacy-terms.md`）：状態の行に、この改定の改定日（マージしてデプロイする日）を入れる。変更履歴に実装の1行。
- T-12（`docs/specs/T-12-release.md`）：「振り分け」に、`/` を Cookie の有無で紹介のページと SPA に分けること（この仕様書の「1.」）と、`landing.html` のビルドの検査（「5.」）を足す。
- T-11（`docs/specs/T-11-design.md`）：「画面のつながり」の表に、未ログインの `/` は紹介のページ（静的な HTML。T-44）であることを1行足す。
- T-12（`docs/specs/T-12-release.md`）：決定事項7・人が行う作業3・「本番にしたときの扱い」・スコープ外・確認事項（未解消）を「使うスコープはすべて機微でないので、ブランドの確認だけを受ける（T-44 のデプロイのあと）。確認を済ませるまでは、同意画面にアプリ名を出さない」に直す（確認されていないアプリの警告と、連携の累計100人の上限は当たらない）。
- 要求定義書（`docs/requirements.md`）：リスクの表の「Googleのセンシティブスコープ審査」と、残りの論点の「Googleの審査（一般公開のとき…）」を、上の T-12 と同じ内容（機微でないスコープだけなので、ブランドの確認だけ。ホームページは T-44）に合わせる。
- `.github/pull_request_template.md`：プライバシー ポリシーの確認の項目に「紹介のページ（`apps/web/landing.html`）」を足す（「9.」）。

## 確認事項（合意前に解消する）
- なし（決めることは PR の「判断してほしいこと」に推奨つきで並べ、返事がなければ推奨のとおりにする）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-24 | 作成 | Google の OAuth の審査（#199）にホームページが要るため。#192 のうち審査に足りる最小の範囲 |
| 2026-11-24 | 実装：前提を「スコープはすべて機微でなく、ブランドの確認だけ」に直した。「7.」の英文を公式の形にし、使い道をカレンダーの情報に絞り、メールアドレスの使い道と解除で残るものを日本語の本文に合わせた。「1.」の `Vary` は追加（もとの値を残す）。「5.」の検査を `landingProblems` に切り出した。E2E を JavaScript ありと切ったものに分けた。「実装PRで直すもの」に T-12 と要求定義書の審査の記述を足した | 実装PR。仕様書PR #219 のレビュー、持ち主が Google Cloud Console で確かめたスコープの区分 |
| 2026-11-24 | ビルドの検査に「landing.html に HTML のコメントがない」を足した（vite は HTML を圧縮しないので、内部の説明が本番に出るため）。説明は landing.css の冒頭へ移した | T-44 実装PR（#222）のセキュリティのレビュー |
