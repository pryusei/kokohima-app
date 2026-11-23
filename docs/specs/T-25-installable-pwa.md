# T-25 仕様書：ホーム画面に追加しやすくする（PWAのインストール体験）

- 状態：下書き
- タスク票：docs/tasks/T-25-installable-pwa.md
- 関係する要件：要求定義書「形態」（PWA先行）、F-16（通知）。T-07「プッシュの購読と Service Worker」の iOS の項

## 概要
最初のリリースはアプリストアに出さない PWA だけにする（T-12）。iOS では、ホーム画面に追加した PWA だけがWebプッシュを受け取れる（T-07）ので、追加してもらえるかどうかが通知の届きやすさを決める。今の manifest はアイコンが SVG 1枚だけで、iOS・Android で崩れたり追加の候補に出なかったりする。アイコンと manifest を整え、設定に「追加の案内」の画面を足して、追加のあとに通知の設定へつなぐ。アプリ（ストア）としての公開は、このタスクではやらない（決定事項1）。

## 決めたこと
1. **ストア公開は今はやらない。** PWA の追加の体験を整えるところまでにする。Android の TWA（Play の登録料が必要）や Capacitor（Apple Developer Program が必要で、Google ログインがアプリ内 WebView で使えず、`__Host-` の Cookie と同一オリジンの前提も崩れる）は、友達との運用で「ストアに載っていないと使ってもらえない」などの声が出てから、別のタスクで決める。T-07・T-10 の「ネイティブは対象外」もそのまま。
2. **案内は設定の中に置き、自動のバナー・ポップアップは出さない。** 「友達を誘う気まずさをなくす」アプリなので、追加を急かさない。「あとで」の記憶も要らなくなり、ブラウザに何も保存しないので、プライバシー ポリシーの「ブラウザに保存するもの」を変えずに済む。
3. **`shortcuts`・`share_target`・バッジは足さない。** 確かめる経路が増えるわりに、今の使い方に効かない。
4. **Service Worker に `fetch` の処理を足さない。** オフラインのキャッシュはしない（T-11）。追加の候補に出る条件は決定事項と確認事項に書いたとおり、実機で確かめる。

## 画面

### 設定のトップ
「このアプリについて」の先頭に「アプリとして使う」（`Row`、行き先 `/settings/install`）を足す。プライバシー ポリシー・利用規約の上。

### `/settings/install`（`SubScreen`、戻り先 `/settings`）
表示は、次の順で最初に当てはまる1つにする。

| 状態 | 見出しの下の文 | 操作 |
| --- | --- | --- |
| ホーム画面から開いている（`matchMedia("(display-mode: standalone)")`、または iOS の `navigator.standalone`） | 「ホーム画面から開いています」 | 「通知の設定へ」（`/settings/notifications`） |
| `beforeinstallprompt` を受け取った | 「ホーム画面に追加すると、すぐ開けて、通知も受け取れます」 | 「ホーム画面に追加」のボタン。押すと保存しておいたイベントの `prompt()` を呼ぶ。結果（追加した／閉じた）は静かに扱い、閉じても何も出さない |
| iOS（UA に iPhone・iPad を含む、または `MacIntel` でタッチ点が2以上） | 「ホーム画面に追加すると、通知を受け取れます」 | 手順を番号つきで出す：1. Safari で開く 2. 共有のボタンを押す 3.「ホーム画面に追加」を選ぶ 4. ホーム画面のアイコンから開く |
| それ以外 | 「ブラウザのメニューから、ホーム画面に追加（またはインストール）できます」 | なし |

- 「それ以外」には、LINE などアプリ内のブラウザで開いている人向けに、「うまく追加できないときは、Safari か Chrome で開き直してください」の一文を足す（アプリ内のブラウザかどうかの判定はしない。UA の判定は壊れやすいため）。
- `beforeinstallprompt` は `preventDefault()` して、メモリ（コンポーネントの state か、画面の外の変数）にだけ保存する。ブラウザに保存しない。`appinstalled` を受けたら、保存したイベントを捨てて「ホーム画面に追加しました。通知の設定へ」を出す。
- 通知の許可はこの画面では取らない。取るのは今までどおり通知の設定の、利用者が押したときだけ（T-07）。
- 色は T-11 のトークンだけを使う。「閉じた」「追加できない」に赤やエラー色を使わない（静かな状態）。部品は `apps/web/src/ui/` のものを使う。PC の配置（T-20）では、左のナビの「設定」が今の画面になる。

### 通知の設定
T-07 の「ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます」の文に、`/settings/install` へのリンク（「追加の方法」）を足す。ほかの文言は変えない。

## アイコンと manifest

### 画像
- `apps/web/public/` に、いまの `icon.svg`（黄色の角丸の正方形に白い円）から作った次の4つを足す（`icon.svg` は残す）。
  - `icon-192.png`（192×192）、`icon-512.png`（512×512）：角丸のまま、`purpose: "any"`
  - `icon-maskable-512.png`（512×512）：角丸なしで全面を黄色にし、円は中央の80%の安全領域に収める（`purpose: "maskable"`。OS が丸や角丸に切り抜く）
  - `apple-touch-icon.png`（180×180）：角丸なしの全面の黄色（iOS が角丸にする。透過があると黒くなるため透過させない）
- 画像は ImageMagick（`convert`）などで作って、そのままコミットする。作り方は `apps/web/public/README.md` に1行で残す。ビルドでは作らない。

### `manifest.webmanifest`
```json
{
  "id": "/",
  "name": "ここ暇",
  "short_name": "ここ暇",
  "description": "友達を誘う気まずさをなくす",
  "lang": "ja",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f8f7f6",
  "theme_color": "#fcd34d",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```
- `start_url` に利用者の情報・トークン・招待リンクのトークンを入れない。
- `background_color` は `index.css` のライトの `--kh-bg`（`#f8f7f6`）に合わせる。`theme_color` は今のまま（`#fcd34d`）。ダークの配色は manifest では切り替えられないので、`index.html` の `<meta name="theme-color">` に `media="(prefers-color-scheme: dark)"` つきの2つを置く（ライト `#fcd34d`、ダーク `#1b1a17`）。

### `index.html`
```html
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="theme-color" content="#fcd34d" media="(prefers-color-scheme: light)" />
<meta name="theme-color" content="#1b1a17" media="(prefers-color-scheme: dark)" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="ここ暇" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
```

### 配信
- 画像は静的アセットとして同じ Worker から出る（T-12）。CSP は変えない（`img-src 'self' data:`、`manifest-src 'self'`）。HTML と `/sw.js` だけ no-cache の今の扱いのまま、画像と manifest に特別な `Cache-Control` は付けない。

## API
なし。サーバー・D1・outbox・Queue・秘密情報は変えない。

## データ
なし。マイグレーションなし。ブラウザの localStorage・sessionStorage・Cookie も足さない（プライバシー ポリシーと `packages/shared/src/retention.ts` は変えない）。

## 振る舞い
- 案内の表示は、画面を開いた時点の状態で決める。`display-mode` の変化（`matchMedia` の `change`）と `appinstalled` は購読して、表示を更新する。購読はアンマウントで外す。
- `beforeinstallprompt` が来ない端末（iOS、すでに追加済み、条件を満たさない）では、ボタンを出さない。来た後で `prompt()` は1回しか呼べないので、押したら保存したイベントを捨てる。
- `matchMedia`・`navigator.standalone`・`beforeinstallprompt` がない環境（テスト・古いブラウザ）でも例外にならず、「それ以外」の表示になる。
- ログインしていない人には、この画面を出さない（設定の下にあるので、今までの認証の扱いのまま）。

## 認可と秘匿
- 閲覧者IDの使い方：使わない。この画面は端末の状態（追加済みか）だけで決まり、サーバーのデータを読まない。
- 他人のデータに届かないことの保証：API を足さず、利用者のデータを読み書きしない。そのため「他人のIDでは取得できない」テストの対象外。
- 区別させない応答：該当なし（見せない相手・暇がない相手・募集の応答者を扱わない）。
- manifest・`index.html`・画像に、利用者・招待・トークンに関わる値を入れない。ログ・エラーにも何も出さない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] manifest：JSON を読み、`id`・`scope`・`display`・`start_url`、PNG と maskable のアイコンがあること。`src` のファイルが `public/` にあり、PNG の実際の大きさ（ヘッダーを読む）が `sizes` と一致すること。`apple-touch-icon.png` が180×180であること
- [ ] `index.html`：`apple-touch-icon`・`theme-color`（ライト・ダーク）・`manifest` のリンクがあること
- [ ] 案内の画面（正常系）：standalone のとき「ホーム画面から開いています」と通知の設定へのリンク。`beforeinstallprompt` を発火するとボタンが出て、押すと `prompt()` が1回呼ばれてボタンが消える。iOS の UA で手順の4つが出る。それ以外の UA で一般の案内と「Safari か Chrome で開き直してください」が出る
- [ ] `appinstalled` を受けると「ホーム画面に追加しました」が出る。`display-mode` の `change` で表示が切り替わる
- [ ] 境界：`matchMedia`・`navigator.standalone` がない環境で例外にならない。`prompt()` が拒否されても何も出ず、エラー色の要素がない
- [ ] 設定のトップに「アプリとして使う」があり、`/settings/install` へ行く。通知の設定の注記から案内へ行ける
- [ ] localStorage・sessionStorage・`document.cookie` に何も書かない（画面の操作の前後で変わらない）
- [ ] 他人のIDでは取得・更新できない：API を足さないので対象外（上の「認可と秘匿」）

### E2Eテスト（対象にする利用者の流れ）
- [ ] ログインして、設定 →「アプリとして使う」を開くと案内が出る（Chromium。`beforeinstallprompt` はテストで発火して、ボタンが出るところまで）。iOS の手順は WebKit のプロジェクト（T-21）で確かめる
- ログイン・誘い〜成立の流れは今までの E2E で確かめている。この仕様書は、その流れを変えない

## スコープ外
- アプリストアへの公開（Android の TWA、Capacitor）。決定事項1
- 自動のバナー・ポップアップ、「あとで」の記憶。決定事項2
- `shortcuts`・`share_target`・バッジ。決定事項3
- オフライン対応（T-11）、アプリ内ブラウザの判定

## 実装PRで直すもの
- `docs/specs/T-07-notification.md`：iOS の項（`manifest.webmanifest` の中身と、追加の案内の行き先）
- `docs/specs/T-11-design.md`：設定の「アプリとして使う」の行と `/settings/install` の画面
- `docs/specs/T-12-release.md`：「アプリストアには出さない」の行に、この仕様書へのリンク（追加の体験を整えた）
- `docs/requirements.md`：形態の行（追加の案内を設定に置く）
- `docs/roadmap.md`：「あとで」に、ストア公開（TWA・Capacitor）と、判断のきっかけ（「ストアに載っていないと使ってもらえない」声、iOS のプッシュが届かない人の多さ）を足す
- `docs/design/` の画面一覧（`/settings/install` を足す）
- この仕様書の状態を「実装済み」にする

## 確認事項（合意前に解消する）
- 追加の候補に出る条件（Service Worker の `fetch` の処理が要るか）は、この環境から公式の資料を読めておらず、確かめていない。実装PRで、Chromium の DevTools の Application →「Manifest」のインストール可否と、Android の実機で確かめる。`fetch` の処理が必要と分かったら、オフラインのキャッシュはせず（T-11）、何もしない素通しの `fetch` だけを足す案を、この仕様書を直して決める
- アイコンの絵柄（今の黄色の角丸に白い円）のままでよいか。変えるなら画像だけ差し替えれば済む
- iOS の手順の文言（Safari 以外のブラウザの iOS では追加の操作が違う）。まず Safari の手順だけ出して、足りなければ直す

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書き | アプリ化は PWA の追加の体験を整えるところから始めると、利用者と決めた |
