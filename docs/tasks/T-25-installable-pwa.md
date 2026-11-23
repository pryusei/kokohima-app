# T-25 ホーム画面に追加しやすくする（PWAのインストール体験）

## 目的
最初のリリースは Web（PWA）だけで、アプリストアには出さない（T-12）。iOS ではホーム画面に追加した PWA だけがWebプッシュを受け取れる（T-07）ので、「追加してもらえるか」が通知の届くかどうかを決める。今の `manifest.webmanifest` は SVG のアイコン1枚だけで、端末によってアイコンが崩れたり、追加の候補に出なかったりする。追加の手順を迷わず進められるようにし、追加後は通知の設定につなぐ。

## 関係する要件
- 要求定義書「形態」（PWA先行）、F-16（通知）
- T-07（iOS はホーム画面に追加した PWA でだけWebプッシュを受け取れる。`manifest.webmanifest` を足す）
- T-11（デザイン。オフラインのキャッシュはしない）、T-12（アプリストアには出さない。CSP・セキュリティのヘッダー）、T-19（ブラウザに保存するもの。この仕様書は新しく保存しない）、T-20（PC の配置）、T-21（WebKit の E2E）

## スコープ
- やること：
  - アイコン（PNG 192・512、maskable 512、`apple-touch-icon` 180）を `apps/web/public/` に足し、`manifest.webmanifest`（`id`・`scope`・`lang`・`description`・PNG と maskable のアイコン）と `index.html`（`apple-touch-icon`・`theme-color`・`apple-mobile-web-app-*`）を直す
  - 設定の「このアプリについて」に「アプリとして使う」を足し、`/settings/install` に追加の案内（Android／Chrome は `beforeinstallprompt` のボタン、iOS は手順、追加済みは静かな表示）を作る
  - 通知の設定の「ホーム画面に追加すると〜」の文に、案内への行き先を足す
  - 単体テストと E2E
- やらないこと（スコープ外）：
  - アプリストアへの公開（Android の TWA、Capacitor）。ストアに載っていないと使ってもらえない、という声が出てから決める
  - 自動で出るバナー・ポップアップ、「あとで」の記憶（ブラウザに何も保存しない）
  - オフライン対応（Service Worker のキャッシュ）、`shortcuts`・`share_target`・アプリのバッジ

## 受け入れ条件
- [ ] manifest に PNG（192・512）と maskable（512）があり、画像の実際の大きさが宣言と一致する。`id`・`scope` が `/`、`display` が `standalone`
- [ ] `index.html` に `apple-touch-icon`（180）と `theme-color` がある。CSP（`img-src 'self' data:`・`manifest-src 'self'`）を変えずに動く
- [ ] 設定 →「アプリとして使う」で、`beforeinstallprompt` が来た端末ではボタンが出て、押すと追加のダイアログが開く。出ない端末（iOS Safari など）では、手順（共有 →「ホーム画面に追加」）が出る
- [ ] ホーム画面から開いているとき（`display-mode: standalone`、iOS の `navigator.standalone`）は、追加の案内ではなく「ホーム画面から開いています」が静かに出て、通知の設定への行き先がある
- [ ] 赤やエラー色を使わない。ブラウザに何も保存しない（localStorage・sessionStorage・Cookie を足さない）
- [ ] 通知の設定の、追加していない人向けの文から案内に進める
- [ ] 他人のデータを扱う API を足さないので「他人のIDでは取得できない」テストの対象外であることを、仕様書に理由つきで書いてある
- [ ] 仕様書の「実装PRで直すもの」（T-07・T-11・T-12・要求定義書・ロードマップ）が直っている
