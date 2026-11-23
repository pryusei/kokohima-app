# T-21 仕様書：iPhone の Safari（WebKit）で E2E を回す

- 状態：実装済み
- タスク票：docs/tasks/T-21-webkit-e2e.md
- 関係する要件：要求定義書「形態」（PWA 先行）。T-11（docs/specs/T-11-design.md）

## 概要
- 今の E2E は Chromium（`Desktop Chrome`）だけで回している。iPhone の Safari だけで起きる不具合は、E2E では見つからない。T-11 の日付・時刻の入力欄のはみ出しがその例で、今は単体テストで CSS の指定があることを確かめているだけ（pryusei/kokohima-app#139 のレビュー）。
- Playwright の WebKit を iPhone の端末の設定で動かすプロジェクトを足し、印を付けた利用者の流れだけを WebKit でも回す。CI でも回す。
- 変えるのは E2E の設定・テスト・CI だけ。アプリ（`apps/web`・`apps/api`）は変えない。

## API
変えない。

## データ
変えない（マイグレーションなし）。

## 振る舞い

### Playwright のプロジェクト（決定事項1）
- `playwright.config.ts` の `projects` に `iphone` を足す：
  - `use: { ...devices["iPhone 13"], baseURL: "https://localhost:5174", ignoreHTTPSErrors: true }`（WebKit。幅390px・タッチ・モバイルの User-Agent）。
  - `grep: /@iphone/`：印（タグ `@iphone`）を付けたテストだけを回す。`release.spec.ts` と `desktop.spec.ts` は回さない。
- `mobile`（T-20 で `chromium` から名前が変わった。Chromium・幅390px）・`desktop`・`release` のプロジェクトは変えない。印を付けたテストも、`mobile` では今までどおり回す。

### WebKit のための HTTPS の画面と API（確認事項2の結果）
- WebKit は `http://localhost` では、更新用トークンの Cookie（`__Host-`・`Secure`）を保存しない。そのため `http://localhost:5173` のままでは、`iphone` のテストはすべてログインの画面に戻された（実装PRで確かめた）。
- アプリの Cookie の設定と Origin の確認は変えず、テスト用の環境だけで回避する：
  - 画面：`E2E_HTTPS=1` のときだけ、vite を `@vitejs/plugin-basic-ssl`（開発用の依存。自己署名の証明書）で HTTPS にする。`iphone` 用に `https://localhost:5174` で起動し、`ignoreHTTPSErrors` で証明書の警告を無視する。
  - API：E2E の API（`:8787`）は `APP_ORIGIN` が `http://localhost:5173` で、ほかの Origin からの更新用トークンの交換を断る。そこで `iphone` 用に、`APP_ORIGIN` を `https://localhost:5174` にした E2E の API を `:8789` で別に起動する（`pnpm --filter api dev:e2e:https`）。HTTPS の画面はこちらへ中継する。
  - 別の API のローカルの D1 などの保存先は `.wrangler/state-https` に分け、秘密情報のファイルも `.dev.vars.https` に分ける（並んで起動するサーバーが同じファイルを取り合わないように）。どちらもコミットしない。
- `webServer`（API・画面）は、今の3つに、この2つ（`:8789` の API と `:5174` の画面）を足す。

### WebKit で回すテスト（決定事項2）
- 次のテストに `{ tag: "@iphone" }` を付ける。iPhone で使う中心の流れと、T-11 のシート・入力欄に関係するものに絞る：

  | ファイル | テスト |
  | --- | --- |
  | `e2e/auth.spec.ts` | ログイン済みでアプリを開くとホーム（みんな）になり、再読み込みしても続く |
  | `e2e/auth.spec.ts` | ログイン中、localStorage・sessionStorage にアクセストークンがない |
  | `e2e/navigation.spec.ts` | 4つのテストすべて（下のタブ、募集の作成のシートを「閉じる」で閉じる、誘いの詳細のシート、URL を直接開いて閉じる） |
  | `e2e/invites.spec.ts` | AがBの見えている枠から誘う（あそぼ）→ Bが「行く」→ 双方の「成立」に予定が出る |
  | `e2e/broadcasts.spec.ts` | AがB・C・Dに募集 → BとCが応じる → Aには人数だけ → 決める → A・B・Cに予定、Dは募集中のまま |
  | `e2e/contact.spec.ts` | 友達タブ → 設定 → 問い合わせで、不具合を送ると「送りました」が出て、偽の Slack にエスケープされて1通届く（T-24。複数行の入力欄・チップ・画面の幅のはみ出し） |

- 新しいテストを WebKit でも回すかは、そのテストの仕様書で決める（決めたら `@iphone` を付ける）。

### T-11 の入力欄のはみ出しの確認
- `e2e/navigation.spec.ts` の「スマホの幅で、みんなタブから開いた募集の作成のシートを『閉じる』のボタンで閉じると…」で、シートの横のスクロールに加えて、日付・開始・終了の入力欄の右端がシートの右端を越えないことを確かめる（`boundingBox()` で比べる）。
- 実装PRで、`apps/web/src/index.css` の日付・時刻の入力欄の指定と `inputClass` の `min-w-0`・`max-w-full` を一時的に外し、WebKit のこのテストが落ちるかを確かめた。
  - 結果：落ちなかった（Linux の WebKit では、iPhone の Safari の日付の入力欄のはみ出しは再現しない。確認事項1の結果）。そのため、はみ出しは今までどおり単体テスト（`apps/web/src/ui/form.test.ts`）で守る。T-11 のテスト計画にも書いた。E2E の確認は、ほかのはみ出しを見つけるためにそのまま残す。
- `navigation.spec.ts` のこのテストの `page.setViewportSize({ width: 390, height: 844 })` は、`mobile` で回すときのために残す。

### CI（決定事項3）
- CI の E2E（`.github/workflows/e2e.yml`）で WebKit も回す。T-21 では `playwright install --with-deps chromium` を `chromium webkit` にした。T-30 で `playwright install --with-deps` をやめ、Chromium と WebKit の入った Playwright の公式のコンテナで回すようにした（docs/specs/T-30-ci-review.md「3. E2E」）。`pnpm e2e` は今のまま（全プロジェクトが回る）。
- ジョブは1つのまま分けない。`timeout-minutes` は今の30分のまま。実装PRで CI の時間を測り、PR の説明に書く。
- 落ちたときのレポートの保存（`playwright-report`）は今のまま。

### ローカル
- `pnpm e2e` は全プロジェクトを回す。WebKit が入っていないと `iphone` のプロジェクトが落ちるので、最初に `pnpm exec playwright install webkit` を実行する（Linux では `--with-deps`）。
- Chromium だけで回すときは `pnpm e2e --project mobile`。
- 上の手順を `e2e-testing` スキル（`.claude/skills/e2e-testing/SKILL.md`）に書く。

## 認可と秘匿
- 閲覧者IDの使い方：変えない。
- 他人のデータに届かないことの保証：変えない。テスト用ログイン（`POST /__e2e__/login`）は今までどおり E2E の環境でだけ使う。
- 区別させない応答：変えない。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] Playwright の設定：`iphone` のプロジェクトがあり、WebKit（`defaultBrowserType` が `webkit`）で、`grep` が `@iphone`、画面は `https://localhost:5174` になっている。`release.spec.ts`・`desktop.spec.ts` を回さない。`mobile`・`desktop`・`release` は Chromium のままで、印で絞らない。HTTPS の画面と `:8789` の API を起動する（設定を import して確かめる。Vitest の `e2e-config` のプロジェクト、`e2e/playwright-config.unit.ts`。Playwright が拾わないように `*.unit.ts` にする）。
- [x] 印の付け忘れの検査：上の表のテストに `@iphone` が付いている（`e2e/*.spec.ts` を読み、テストの名前と印を確かめる。Vitest）。

### E2Eテスト（対象にする利用者の流れ）
- [x] 上の表のテストが、`iphone`（WebKit）と `mobile` の両方で通る。
- [x] 募集の作成のシートで、日付・開始・終了の入力欄がシートの右端を越えない（`iphone` と `mobile`）。

## スコープ外
- すべての E2E を WebKit で回すこと（CI の時間が倍になる）。
- Firefox・Android の Chrome・本物の iPhone（実機・クラウドの端末）でのテスト。
- スクリーンショットの差分の比較。
- WebKit で見つかった不具合のアプリの修正（別のタスク）。
- T-20（PC の配置）の `mobile`・`desktop` のプロジェクトの変更（T-20 の実装PRで入った。`iphone` は `mobile` と同じ流れのうち印を付けたものを WebKit で回す）。

## 決定事項（仕様書PRのレビューで合意する）
1. WebKit は `devices["iPhone 13"]` の1つのプロジェクトで回す。（提案）
2. WebKit で回すのは `@iphone` の印を付けたテストだけにし、ログイン・シート・誘い〜成立・募集〜決定の流れに絞る。（提案。CI の時間を抑えるため）
3. CI は今の E2E のジョブの中で WebKit も回し、ジョブを分けない。（提案）

## 確認事項（合意前に解消する）
- なし（実装PRで解消した）
  - Linux の WebKit で、iPhone の Safari の日付の入力欄のはみ出しが再現するか → 再現しない。上の「T-11 の入力欄のはみ出しの確認」のとおりにした。
  - WebKit で、`http://localhost` の更新用トークンの Cookie（`Secure` 付き）が送られるか → 保存されない。上の「WebKit のための HTTPS の画面と API」で回避した（回避の方法は利用者と決めた）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 初版 | 利用者の依頼（pryusei/kokohima-app#139 のレビューで、iPhone のはみ出しは Chromium の E2E では再現しないと指摘された） |
| 2026-11-23 | 実装した。WebKit は `http://localhost` で `Secure` の Cookie を保存しないので、`iphone` 用に HTTPS の画面（`:5174`）と Origin を合わせた E2E の API（`:8789`）を足した（利用者と決めた）。Linux の WebKit では iPhone のはみ出しが再現しないことを確かめた。T-20 で `chromium` のプロジェクトが `mobile` になったのに合わせた | 実装PR |
| 2026-11-23 | WebKit で回すテストに問い合わせの流れを足した | T-24 実装PR（docs/specs/T-24-contact.md） |
| 2026-11-23 | CI の E2E を Playwright の公式のコンテナで回すようにした（`playwright install --with-deps` をやめた） | T-30 実装PR（docs/specs/T-30-ci-review.md） |
