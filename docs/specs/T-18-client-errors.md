# T-18 仕様書：画面（PWA）のエラーの収集

- 状態：下書き
- タスク票：docs/tasks/T-18-client-errors.md
- 関係する要件：要求定義書「技術の選定」の監視、「AI時代の攻撃を前提にした運用」、「保存するデータを減らす」。issue pryusei/kokohima-app#88

## 概要
`apps/web` には、画面で起きたエラーを集める仕組みがなく、描画の失敗やプッシュの購読の失敗に、友達から言われるまで気づけない。画面のエラーを、許可した項目だけにして自前の API に送り、Workers Logs に出す（保存はしない）。T-13 のアラートで気づけるようにする。描画が壊れたときは、真っ白にせず、静かな画面と「読み込み直す」を出す。

## 決めたこと（利用者の回答）
1. 集め方：自前の API で受けて、Workers Logs に出すだけ。D1 には保存しない。外部のサービスは使わない（画面の CSP の `connect-src 'self'`（T-12 リリース）も変えない）。
2. ログインしていない画面（ログインの画面・招待リンクの受け口など）のエラーも集める。IP ごとの回数の上限と、同じオリジンの確認で守る。
3. 描画の例外で画面が壊れたら、「うまく表示できませんでした」と「読み込み直す」を出す（赤を使わない）。

## API
`api-conventions` に従う。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/client-errors` | なし（同じオリジン） | body：`clientErrorReportSchema` | 204 | 400 `validation_failed`、401（同じオリジンでない）、413（本文が大きすぎる）、429 `rate_limited` |

- 認証なしで受ける。`Authorization` があっても読まない（ログに利用者を結びつけない。送る側が壊れていることもあるので、受け口を簡単にする）。
- `requireSameOrigin`（`Origin` が `APP_ORIGIN` と一致しなければ401。T-01）。
- 回数の上限：`rateLimit({ group: "client_errors", limiter: "RL_PUBLIC", by: "ip" })`（T-10。`RateLimitGroup` に足す）。超えたら429（`Retry-After`）。
- 本文は 4KB まで（`Content-Length` と読み込んだ長さで確かめ、超えたら413。本文を読み切らない）。
- `Idempotency-Key` は受け付けない（同じ報告が2回届いてもログが1行増えるだけ。T-10 の対象外の表に足す）。

`clientErrorReportSchema`（`packages/shared`。`.strict()`。知らない項目があれば400）：

| 項目 | 型 | 制約 |
| --- | --- | --- |
| `kind` | enum | `error`（捕まえていない例外）・`unhandledrejection`・`render`（描画の例外）・`push_subscribe`（プッシュの購読の失敗）・`sw_register`（Service Worker の登録の失敗） |
| `name` | string | 例外の名前（`TypeError` など）。1〜64文字、`^[A-Za-z0-9._-]+$`。名前が取れなければ `unknown` |
| `route` | string | ID を伏せたパス。1〜200文字、`/` で始まる、`?`・`#`・空白・制御文字を含まない |
| `appVersion` | string | 1〜40文字、`^[A-Za-z0-9._-]+$` |
| `online` | boolean | `navigator.onLine` |

## データ
なし（保存しない。マイグレーションなし）。

## 振る舞い

### 1. API の側
- 検証に通った項目だけを、`console.warn(JSON.stringify({ event: "client_error", kind, name, route, appVersion, online }))` で出す。`requestId` は今のログの書き方どおり付く。IP・User-Agent・利用者 ID は出さない。
- 検証に落ちた要求（400・413）は、ログを出さない（偽の報告でログを汚させない。回数の上限の超過は今の `rate_limited` のログのまま）。
- 何も保存しない。Workers Logs の保持（7日。T-13）で消える。

### 2. 画面の側で集めるもの
- 置き場所：`apps/web/src/errors/report.ts`（送る処理と項目の組み立て）と、描画の例外の ErrorBoundary。
- 集めるもの：
  - `window.addEventListener("error")`：`kind: "error"`。名前は `event.error?.name`。
  - `window.addEventListener("unhandledrejection")`：`kind: "unhandledrejection"`。名前は `reason?.name`。
  - ErrorBoundary（`apps/web/src/main.tsx` で `App` の外側を包む）：`kind: "render"`。
  - プッシュの購読の失敗（`apps/web/src/notifications/push.ts` の `enablePush`・`resendSubscription` で例外になったとき）：`kind: "push_subscribe"`。利用者が通知を許可しなかったこと（`Notification.permission` が `denied`）はエラーにしない。
  - Service Worker の登録の失敗（`registerServiceWorker` の `catch`）：`kind: "sw_register"`。
- 集めないもの：API の 4xx・5xx（API のログで分かる）、通信できなかったこと（`ApiError(0)`。オフラインは障害でない）、送る処理そのものの失敗。

### 3. 送る内容の組み立て（許可リスト）
- `route`：`location.pathname` だけを使う（query とフラグメントは使わない）。パスの区切りごとに、UUID・数字だけ・20文字以上の英数字と `-_`（トークンの形）を `:id` に置き換える。例：`/invites/6f1c…` → `/invites/:id`。`/invite`（招待トークンはフラグメントにある。T-02）も `/invite` のまま。
- `name`：例外の `name` を許可した文字だけにし、64文字で切る。合わなければ `unknown`。
- 送らないもの：例外のメッセージとスタック（ひとこと・表示名・URL が入りうる）、URL の query・フラグメント、トークン、表示名、User-Agent。
- `appVersion`：vite の `define` で、ビルドのときに `__APP_VERSION__` を入れる（git の短い SHA。取れなければビルドの日時 `YYYYMMDDHHmm`）。本番のビルドの検査（`check-web-dist`。T-12 リリース）に影響しない値にする。

### 4. 送り方
- `fetch("/api/v1/client-errors", { method: "POST", keepalive: true, credentials: "omit", headers: { "Content-Type": "application/json" }, body })`。`apiFetch` は使わない（アクセストークンを付けず、401 で更新しない）。
- 1ページ（読み込みから次の読み込みまで）の間、同じ `kind`＋`name`＋`route` は1回だけ、全部で10件まで送る。
- 送る処理の失敗（通信できない・429 など）は握りつぶし、もう一度送らない（エラーの報告がエラーを生んでループしないように）。

### 5. 壊れたときの画面
- ErrorBoundary が描画の例外を捕まえたら、アプリの代わりに「うまく表示できませんでした」と「読み込み直す」（`location.reload()`）を出す。
- 色・余白は `apps/web/src/index.css` のトークン、ボタンは `apps/web/src/ui/` の部品。赤やエラー色は使わない（CLAUDE.md）。ルーターや TanStack Query に頼らずに描ける形にする（それらが壊れていることもあるため）。
- 例外の内容は画面に出さない。

### 6. 監視
- T-13 の「気づけばよい（`#kokohima-notices`）」の表に、`client_error`（1時間に5件以上）を足す。`kind`・`route`・`appVersion` で絞ってログを見る、を手順書に書く（実装PRで T-13 の表と `docs/runbooks/monitoring.md` を直す）。

## 認可と秘匿
- 閲覧者IDの使い方：使わない。認証なしで受け、`Authorization` も読まない。ログに利用者 ID を出さない。
- 他人のデータに届かないことの保証：読み取りがなく、何も保存しない。
- 区別させない応答：受け取ったかどうかで応答を変えない（検証に通れば204）。
- 秘匿：送る項目は許可リストだけで、メッセージ・スタック・URL の query とフラグメント・トークン・表示名は送らない。API も許可した項目だけをログに出す（ログに個人情報・トークンを出さない。CLAUDE.md）。
- 悪用：偽の報告はログが増えるだけ。IP ごとの回数の上限・本文の上限・同じオリジンで抑える。アラートの閾値を偽の報告で鳴らされることは受け入れる（`#kokohima-notices` の「気づけばよい」なので、すぐの対応は要らない）。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] API：正しい本文で204、ログは `event: "client_error"` と許可した5項目だけ（IP・User-Agent・利用者 ID が出ない）
- [ ] API：知らない項目・長すぎる値・許されない文字・`?` や `#` を含む `route` は400で、ログを出さない
- [ ] API：本文が4KBを超えると413
- [ ] API：同じオリジンでない・`Origin` がない要求は401。ログインしていなくても204
- [ ] API：回数の上限で429（`Retry-After`）
- [ ] API：`Authorization` があっても読まない（不正なトークンでも204、ログに利用者 ID がない）
- [ ] Web：`route` の置き換え（UUID・数字・長いトークン、query とフラグメントを使わない、`/invite`）
- [ ] Web：例外のメッセージ・スタックを送らない（メッセージに名前やトークンのような文字列を入れた例外で確かめる）
- [ ] Web：同じエラーは1回、1ページで最大10件
- [ ] Web：`error`・`unhandledrejection`・描画の例外・プッシュの購読の失敗・Service Worker の登録の失敗で送る。通知の拒否（`denied`）では送らない
- [ ] Web：送る `fetch` は `credentials: "omit"`・`keepalive: true` で、`Authorization` を付けない。送信の失敗で例外を出さない
- [ ] Web：ErrorBoundary の画面に「うまく表示できませんでした」と「読み込み直す」が出て、押すと読み込み直す。赤の色を使わない
- [ ] 他人のIDでは取得・更新できない：読み取りがない。既存のテストが通る

### E2Eテスト（対象にする利用者の流れ）
- 対象なし。利用者の流れは変わらず、壊れたときの画面と送る内容は単体テストで確かめる（本番の画面をわざと壊す経路は作らない）。

## 実装PRで直すもの
- 要求定義書：「技術の選定」の監視の行に、画面のエラー（自前の受け口・ログだけ）。
- T-10：回数の上限の表に `client_errors`、`Idempotency-Key` の対象外の表に `POST /client-errors`。
- T-11：壊れたときの画面。
- T-12 リリース：画面の CSP を変えないこと（同じオリジンに送る）の確認を一言。
- T-13：アラートの一覧に `client_error`、手順書に調べ方、ログの一覧に `client_error`。
- `api-conventions` スキル：認証なしで受ける経路（同じオリジン・IP の回数の上限）の例。

## スコープ外
- 外部のエラー収集サービス（利用者と決めた）。
- 例外のメッセージ・スタックの収集。
- Service Worker の中のエラー（今の `sw.js` はプッシュの表示と通知を押したときの処理だけで、通信もキャッシュもしない。登録の失敗だけ集める）。
- D1 への保存、集計の画面。
- 画面に問い合わせ番号を出すこと（T-13）。

## 確認事項（合意前に解消する）
- アラートの閾値（`client_error` が1時間に5件以上）と、本文の上限（4KB）でよいか。（提案：この値で始め、運用で見直す）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-22 | 下書き | pryusei/kokohima-app#88（利用者の回答：自前の API でログだけ、ログインしていない画面も集める、壊れたら静かな画面と「読み込み直す」） |
