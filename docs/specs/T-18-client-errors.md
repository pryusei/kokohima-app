# T-18 仕様書：画面（PWA）のエラーの収集

- 状態：下書き
- タスク票：docs/tasks/T-18-client-errors.md
- 関係する要件：要求定義書「技術の選定」の監視、「AI時代の攻撃を前提にした運用」（異常のアラート、保存するデータを減らす）。issue pryusei/kokohima-app#88

## 概要
`apps/web` には、画面で起きたエラーを集める仕組みがなく、描画の失敗やプッシュの購読の失敗に、友達から言われるまで気づけない。画面のエラーを、決めた値の一覧から選んだ項目だけにして自前の API に送り、Workers Logs に出す（保存はしない）。T-13 のアラートで気づけるようにする。描画が壊れたときは、真っ白にせず、静かな画面と「読み込み直す」を出す。

## 決めたこと（利用者の回答）
1. 集め方：自前の API で受けて、Workers Logs に出すだけ。D1 には保存しない。外部のサービスは使わない（画面の CSP の `connect-src 'self'`（T-12 リリース）も変えない）。
2. ログインしていない画面（ログインの画面・招待リンクの受け口など）のエラーも集める。IP ごとの回数の上限と、同じオリジンの確認で守る。
3. 描画の例外で画面が壊れたら、「うまく表示できませんでした」と「読み込み直す」を出す（赤を使わない）。

## 前提
- T-12 リリース（pryusei/kokohima-app#97）が先に main に入っていること。画面の CSP（`connect-src 'self'`）・`Referrer-Policy: no-referrer`・`apps/web/src/main.tsx`・`apps/web/vite.config.ts` の変更がこの実装と重なるため、実装PRはその後に作る。
- `invocation_logs: false`（T-06 決定事項14・T-13）のままにする。Cloudflare の要求のログに IP・User-Agent・URL を残さないことを前提にする。

## API
`api-conventions` に従う。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/client-errors` | なし（同じオリジン） | body：`clientErrorReportSchema` | 204 | 400 `validation_failed`（形が違う・本文が大きすぎる・JSON でない）、401 `unauthenticated`（同じオリジンでない）、429 `rate_limited` |

- 認証なしで受ける。`Authorization` があっても読まない（ログに利用者を結びつけない。送る側が壊れていることもあるので、受け口を簡単にする）。
- 置き場所：どのコンテキストにも属さないので、`apps/api/src/http/clientErrors.ts` に置き、`app.ts` でつなぐ（深い死活確認の `http/health.ts` と同じ）。スキーマは `packages/shared/src/schemas/clientError.ts`。
- 回数の上限は、この経路のための専用のバインディングを2つ足す（`RL_PUBLIC` の値（60秒に30回）とは別に決めるため。上限の値はバインディングごとに固定）：
  - `RL_CLIENT_ERRORS_IP`：IP ごとに60秒に10回（画面は1ページ10件まで）。
  - `RL_CLIENT_ERRORS_GLOBAL`：全体で60秒に60回。鍵は固定の `client_errors:global`。`rateLimit` に `by: "global"` を足す。
  - どちらも拠点ごとのおおよその数（T-10）。IPv6 は /64 にまとめているが、/48 を持つ相手は IP ごとの上限を避けられるので、実質の歯止めは全体の側。
- 処理の順番（固定）：
  1. 同じオリジン（`requireSameOrigin`。`Origin` が `APP_ORIGIN` と違うか、ないと401 `unauthenticated`。T-01）。別のオリジンの要求は回数を使わない。
  2. IP ごとの回数の上限。超えたら429（`Retry-After`）。
  3. 本文の上限：1024バイト（UTF-8 のバイト数。1024バイトは通し、1025バイトは400）。`Content-Length` と、読み込んだ長さの両方で確かめ、超えたら本文を最後まで読まずに400 `validation_failed`（新しいエラーの code は足さない）。
  4. `Content-Type` が `application/json`（`; charset=utf-8` などの引数は許す）でなければ400 `validation_failed`。
  5. `clientErrorReportSchema` で検証。違えば400 `validation_failed`。
  6. 全体の回数の上限（検証を通った要求だけで数える。検証に落ちた要求・IP ごとで落ちた要求は全体の枠を使わない）。超えたら429。
- この経路では、上限を超えたときの `rate_limited` のログを出さない（`rateLimit` に、超えたときのログを止める設定を足す）。偽の報告でログを増やさせないため。代わりに、全体の上限で落としたときだけ、`{ event: "client_error_dropped" }` を、1つの Worker の実行環境（isolate）で60秒に1行まで出す（本物の報告が落ちていることに運用者が気づけるように）。
- 上限を判定できないとき（バインディングがない・`limit()` の例外・`CF-Connecting-IP` が読めない）は、ほかの経路と違って通さずに204で捨て、`client_error` も `rate_limit_skipped` も出さない（この経路は落としても利用者に害がないため）。
- `Idempotency-Key` は受け付けない（同じ報告が2回届いてもログが1行増えるだけ。T-10 の「受け付けない経路と理由」の「何度送っても結果が同じ」に足す）。

`clientErrorReportSchema`（`packages/shared`。`.strict()`。知らない項目があれば400）。自由な文字列は受けず、どの項目も決めた値の一覧から選ぶ（画面の側の誤りで個人情報が入っても、サーバーで止まるように）：

| 項目 | 型 | 値 |
| --- | --- | --- |
| `kind` | enum | `error`（捕まえていない例外）・`unhandled_rejection`・`render`（描画の例外）・`push_subscribe`（プッシュの購読の失敗）・`sw_register`（Service Worker の登録の失敗） |
| `name` | enum | `TypeError`・`RangeError`・`SyntaxError`・`ReferenceError`・`AbortError`・`NotAllowedError`・`InvalidStateError`・`QuotaExceededError`・`SecurityError`・`NetworkError`・`ZodError`・`Error`・`other` |
| `route` | enum | `/`・`/availability`・`/invites`・`/friends`・`/invites/new`・`/broadcasts/new`・`/invites/:id`・`/broadcasts/:id`・`/meetups/:id`・`/friends/:id`・`/notifications`・`/settings`・`/settings/calendar`・`/settings/presets`・`/settings/notifications`・`/settings/account`・`/login`・`/invite`・`/auth/complete`・`other` |
| `appVersion` | string | `^([0-9a-f]{7,12}\|\d{12})$`（git の短い SHA か、ビルドの日時 `YYYYMMDDHHmm`） |

- `route` と `name` の一覧は、画面の経路や集める例外が変わったら、この表と `packages/shared` を同じPRで直す。

## データ
なし（保存しない。マイグレーションなし）。

## 振る舞い

### 1. API の側
- 検証に通った項目だけを、`console.warn(JSON.stringify({ event: "client_error", kind, name, route, appVersion }))` で出す（この4項目だけ。`requestId`・IP・User-Agent・利用者 ID は出さない）。
- 検証に落ちた要求（400）と、回数の上限を超えた要求（429）は、ログを出さない。
- 何も保存しない。Workers Logs の保持（7日。T-13）で消える。

### 2. 画面の側で集めるもの
- 置き場所：`apps/web/src/errors/report.ts`（送る処理と項目の組み立て）と、描画の例外の ErrorBoundary（`apps/web/src/errors/ErrorBoundary.tsx`）。
- `window` のリスナーは、`main.tsx` の `registerServiceWorker()` より前に登録する（`sw_register` を取りこぼさないため）。
- 集めるもの：
  - `window.addEventListener("error")`：`kind: "error"`。ブラウザの拡張の例外もここで拾われ、`name: other` などで届きうる（受け入れる。閾値は「確認事項」）。
  - `window.addEventListener("unhandledrejection")`：`kind: "unhandled_rejection"`。
  - ErrorBoundary：`apps/web/src/main.tsx` で、`StrictMode` の内側、`QueryClientProvider` の外側に置く（`AuthProvider` の中の例外も捕まえ、TanStack Query に頼らずに描くため）。`kind: "render"`。同じ例外を `error` としても送らない（React 19 は ErrorBoundary が捕まえた例外を `window` の `error` に流さないと理解しているが、念のため、送った例外を覚えておき重ねて送らない）。
  - プッシュの購読の失敗：`apps/web/src/notifications/push.ts` の `enablePush` の中の購読（`pushManager.subscribe`）が例外になったときと、`resendSubscription` の今の `catch` の中。`kind: "push_subscribe"`。
  - Service Worker の登録の失敗：`registerServiceWorker` の `catch`。`kind: "sw_register"`。
- 集めないもの：
  - `ApiError`（`apps/web/src/api/client.ts`。4xx・5xx・通信できない `ApiError(0)`）。API の失敗は API のログで分かり、オフラインは障害でないため。`unhandled_rejection` と `push_subscribe` でも、`reason instanceof ApiError` なら送らない。
  - 利用者が通知を許可しなかったこと（`Notification.permission` が `denied`、または `NotAllowedError` で許可がないとき）。
  - 送る処理そのものの失敗。
  - オフラインの間（`navigator.onLine` が false）のエラー。送らず、「1回・10件」の枠も使わない（届かない送信で枠を使い切らないように）。

### 3. 送る内容の組み立て
- `route`：`location.pathname` だけを使い（query とフラグメントは使わない）、`App.tsx` の振り分け（タブの経路と `sheetOf`）と同じ判定で、上の表の値に当てはめる。ID の位置にあるものは、形によらず `:id` にする。どれにも当たらなければ `other`。
- `name`：`Error` のインスタンス（`DOMException` を含む）のときだけ `name` を読み、上の表の一覧にあればその値、なければ `other`。`Error` でない値（`reason` が文字列・物など）は `other`。
- 送らないもの：例外のメッセージとスタック（ひとこと・表示名・URL が入りうる）、URL の query・フラグメント、トークン、表示名、User-Agent。
- `appVersion`：vite の `define` で、ビルドのときに `__APP_VERSION__` を入れる（git の短い SHA。取れなければ UTC のビルドの日時 `YYYYMMDDHHmm`）。Vitest の設定と `vite-env.d.ts` にも定義を足す。本番のビルドの検査（`check-web-dist`。T-12 リリース）に当たらない値にする。

### 4. 送り方
- `fetch("/api/v1/client-errors", { method: "POST", keepalive: true, credentials: "omit", headers: { "Content-Type": "application/json" }, body })`。`apiFetch` は使わない（アクセストークンを付けず、401 で更新しない）。
- `navigator.sendBeacon` と `mode: "no-cors"` は使わない。`sendBeacon` は Cookie を付けて送り、`credentials: "omit"` にできない。画面には `Referrer-Policy: no-referrer` が付くので、`no-cors` では `Origin` が `null` になり、受け口が401にする。
- 1ページ（読み込みから次の読み込みまで）の間、同じ `kind`＋`name`＋`route` は1回だけ、全部で10件まで送る。
- 送る処理の失敗（通信できない・429 など）は握りつぶし、もう一度送らない（エラーの報告がエラーを生んでループしないように）。

### 5. 壊れたときの画面
- ErrorBoundary が描画の例外を捕まえたら、アプリの代わりに「うまく表示できませんでした」と「読み込み直す」（`location.reload()`）を出す。
- 色・余白は `apps/web/src/index.css` のトークン、ボタンは `apps/web/src/ui/` の部品。赤やエラー色は使わない（CLAUDE.md）。ルーター・TanStack Query・ログイン状態に頼らずに描ける形にする。
- 例外の内容（メッセージ・名前）は画面に出さない。

### 6. 監視
- T-13 の「3. ログの追加と、重さの見直し」に `client_error`（warn）を足す。
- T-13 の「4. アラートの一覧」の「気づけばよい（`#kokohima-notices`）」に、`client_error`（1時間に5件以上）を足す。手順書（`docs/runbooks/monitoring.md`）の Monitors の表に足し、`kind`・`route`・`appVersion` で絞ってログを見る手順を書く。
- `rate_limited` のモニターは、この経路では超えたときのログを出さないので、影響を受けない。

## 認可と秘匿
- 閲覧者IDの使い方：使わない。認証なしで受け、`Authorization` も読まない。ログに利用者 ID を出さない。
- 他人のデータに届かないことの保証：読み取りがなく、何も保存しない。トークンを付けて送っても、応答とログに利用者の ID もデータも出ない。
- 区別させない応答：応答の差は 204・400・401・429 だけで、どれも要求の形・`Origin`・送った IP で決まり、利用者の状態に左右されない。
- 秘匿：どの項目も決めた値の一覧から選ぶので、メッセージ・スタック・URL の query とフラグメント・トークン・表示名・自由な文字列がログに入らない。API も許可した4項目だけをログに出す（ログに個人情報・トークンを出さない。CLAUDE.md）。
- 悪用：偽の報告は、IP ごとと全体の回数の上限・本文の上限・同じオリジンで抑え、上限を超えた分はログも出さない。全体の上限の範囲で偽の報告がログを増やし、`client_error` のアラート（「気づけばよい」）を鳴らせることは受け入れる。全体の上限に当たっている間は本物の報告も落ちることを受け入れ、そのことは `client_error_dropped` で運用者に分かるようにする。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] API 正常系：正しい本文で204。ログは `event: "client_error"` と許可した4項目だけ（`requestId`・IP・User-Agent・利用者 ID が出ない）
- [ ] API 入力検証：知らない項目、一覧にない `kind`・`name`・`route`、形の違う `appVersion`、JSON でない本文、`Content-Type` の違いは400で、ログを出さない
- [ ] API 境界値：本文がちょうど1024バイト（空白で埋めた正しい JSON で作る）は204、1025バイトは400。`Content-Type` に `; charset=utf-8` が付いても通る。`Content-Length` がない・偽りの本文でも、読み込んだ長さで400
- [ ] API：同じオリジンでない・`Origin` がない要求は401で、回数の上限を使わない
- [ ] API：ログインしていなくても204。利用者 A のトークンを付けても、応答とログに A の ID もデータも出ない（不正なトークンでも204）
- [ ] API 回数の上限：IP ごとと全体のそれぞれで429（`Retry-After`）。超えたときに `rate_limited` も `client_error` もログが出ない。検証に落ちた要求は全体の枠を使わない。全体で落としたときは `client_error_dropped` が60秒に1行まで
- [ ] API：上限を判定できないとき（バインディングがない・例外）は204で捨て、`client_error` も `rate_limit_skipped` も出ない
- [ ] Web：`route` の当てはめ（タブ・シートの経路、UUID などの ID は形によらず `:id`、`/invites/new` と `/broadcasts/new` は `:id` にしない、知らないパスは `other`、query とフラグメントを使わない、`/invite`）
- [ ] Web：`name` の当てはめ（一覧にある名前、一覧にない名前は `other`、`Error` でない値は `other`）。例外のメッセージ・スタックを送らない（メッセージに表示名やトークンのような文字列を入れた例外で確かめる）
- [ ] Web：同じエラーは1回、1ページで10件目まで送り、11件目は送らない。オフラインの間は送らず、枠も使わない（オンラインに戻ったあとのエラーは送る）
- [ ] Web：`error`・`unhandled_rejection`・描画の例外・プッシュの購読の失敗・Service Worker の登録の失敗で送る。描画の例外は `render` として1回だけ送り、`error` で重ねて送らない
- [ ] Web：`ApiError`（`ApiError(0)` を含む）による拒否、`enablePush`・`resendSubscription` の中の `ApiError`、通知の拒否では送らない
- [ ] Web：送る `fetch` は `credentials: "omit"`・`keepalive: true` で、`Authorization` を付けない。送信の失敗で例外を出さない
- [ ] Web：ErrorBoundary の画面に「うまく表示できませんでした」と「読み込み直す」が出て、押すと読み込み直す。例外のメッセージを出さない。赤の色を使わない
- [ ] 他人のIDでは取得・更新できない：読み取り・保存がない。上の「トークンを付けても A の ID もデータも出ない」で確かめる

### E2Eテスト（対象にする利用者の流れ）
- 対象なし。利用者の流れは変わらず、壊れたときの画面と送る内容は単体テストで確かめる（本番の画面をわざと壊す経路は作らない）。

### 人が確かめること（本番で設定するとき。手順書に書く）
- iOS の PWA（WebKit）で、受け口に送った要求が204になる（`Origin` が付く）。
- 本番の `client_error` のログを1件開き、Workers Logs が自動で付ける項目に IP・User-Agent・URL が含まれないこと（`invocation_logs: false` で消えるのは呼び出しのログで、個々のログに付く項目までは T-13 にも記録がない）。含まれるなら、仕様を直す。
- `client_error` が Workers Issues に拾われていないこと（拾われると「すぐ見る」側にも届き、T-13 の「同じ1件で2通は届かない」が崩れる）。拾われるなら、Issues の対象から外すか、ログの書き方を変える。

## 実装PRで直すもの
- 要求定義書：「技術の選定」の監視の行に、画面のエラー（自前の受け口・ログだけ）。
- T-07：「プッシュの購読と Service Worker」に、購読と登録の失敗を報告すること。
- T-10：回数の上限の表に `client_errors`（専用のバインディング `RL_CLIENT_ERRORS_IP`・`RL_CLIENT_ERRORS_GLOBAL`、`rateLimit` の `by: "global"` と超えたときのログを止める設定）、「受け付けない経路と理由」に `POST /client-errors`。
- T-11：壊れたときの画面。
- T-12 リリース：画面の CSP を変えないこと（同じオリジンに送る）を一言。
- T-13：「3.」に `client_error`、「4.」に `client_error` のアラート。手順書（`docs/runbooks/monitoring.md`）の Monitors の表と調べ方、iOS で確かめる手順。
- `api-conventions` スキル：認証なしで受ける経路（同じオリジン・IP の回数の上限）の例。
- wrangler の設定（4つの環境）と `vitest.config.ts` に、2つのバインディング（`namespace_id` は `infra-change` スキルに従って決める）。`RateLimiterName` に足す。

## スコープ外
- 外部のエラー収集サービス（利用者と決めた）。
- 例外のメッセージ・スタックの収集。
- Service Worker の中のエラー（今の `sw.js` はプッシュの表示と通知を押したときの処理だけで、通信もキャッシュもしない。登録の失敗だけ集める）。
- D1 への保存、集計の画面。
- 画面に問い合わせ番号を出すこと（T-13）。

## 確認事項（合意前に解消する）
- アラートの閾値（`client_error` が1時間に5件以上）・本文の上限（1024バイト）・IP ごとの上限（60秒に10回）・全体の上限（60秒に60回）でよいか。ブラウザの拡張の例外でも鳴りうるので、5件は鳴りやすいかもしれない。（提案：この値で始め、運用で見直す）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-22 | 下書き | pryusei/kokohima-app#88（利用者の回答：自前の API でログだけ、ログインしていない画面も集める、壊れたら静かな画面と「読み込み直す」） |
| 2026-11-22 | `route`・`name` を決めた値の一覧から選ぶ形に、`appVersion` の形を固定、上限を超えた分のログを出さない・全体の上限、処理の順番、本文の上限を400で（新しい code を足さない）、`ApiError` を送らない、ErrorBoundary の位置、`sendBeacon`・`no-cors` を使わない、T-12 リリースの後に実装、テスト計画と直す文書を足す | 仕様書PRの前のレビュー（セキュリティ・仕様） |
| 2026-11-22 | 専用の回数の上限2つ（IP ごと10回・全体60回）と処理の順番（全体は検証のあと）、`client_error_dropped`、判定できないときは捨てる、オフラインでは送らず `online` の項目をやめる、API の置き場所、1024バイトと `charset`、`sendBeacon` を使わない理由、リスナーの登録の順番、人が確かめること（Workers Logs の自動の項目・Issues） | 仕様書PRのレビュー（pryusei/kokohima-app#109） |
