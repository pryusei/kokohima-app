# T-21 仕様書：iPhone の Safari（WebKit）で E2E を回す

- 状態：下書き
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
  - `use: { ...devices["iPhone 13"] }`（WebKit。幅390px・タッチ・モバイルの User-Agent）。`baseURL` は `chromium` と同じ `http://localhost:5173`。
  - `grep: /@iphone/`：印（タグ `@iphone`）を付けたテストだけを回す。`release.spec.ts` は回さない。
- `chromium` と `release` のプロジェクトは変えない。印を付けたテストも、`chromium` では今までどおり回す。
- `webServer`（API・画面）は、今のものを `iphone` でもそのまま使う。

### WebKit で回すテスト（決定事項2）
- 次のテストに `{ tag: "@iphone" }` を付ける。iPhone で使う中心の流れと、T-11 のシート・入力欄に関係するものに絞る：

  | ファイル | テスト |
  | --- | --- |
  | `e2e/auth.spec.ts` | ログイン済みでアプリを開くとホーム（みんな）になり、再読み込みしても続く |
  | `e2e/auth.spec.ts` | ログイン中、localStorage・sessionStorage にアクセストークンがない |
  | `e2e/navigation.spec.ts` | 4つのテストすべて（下のタブ、募集の作成のシートを「閉じる」で閉じる、誘いの詳細のシート、URL を直接開いて閉じる） |
  | `e2e/invites.spec.ts` | AがBの見えている枠から誘う（あそぼ）→ Bが「行く」→ 双方の「成立」に予定が出る |
  | `e2e/broadcasts.spec.ts` | AがB・C・Dに募集 → BとCが応じる → Aには人数だけ → 決める → A・B・Cに予定、Dは募集中のまま |

- 新しいテストを WebKit でも回すかは、そのテストの仕様書で決める（決めたら `@iphone` を付ける）。

### T-11 の入力欄のはみ出しの確認
- `e2e/navigation.spec.ts` の「スマホの幅で、みんなタブから開いた募集の作成のシートを『閉じる』のボタンで閉じると…」で、シートの横のスクロールに加えて、日付・開始・終了の入力欄の右端がシートの右端を越えないことを確かめる（`boundingBox()` で比べる）。
- 実装PRで、`apps/web/src/index.css` の日付・時刻の入力欄の指定と `inputClass` の `min-w-0`・`max-w-full` を一時的に外し、WebKit のこのテストが落ちることを確かめる。
  - 落ちない（Linux の WebKit では iPhone の Safari のはみ出しを再現できない）ときは、その結果を仕様書の変更履歴と T-11 のテスト計画に書き、はみ出しは今までどおり単体テスト（`apps/web/src/ui/form.test.ts`）で守る。テストは、ほかのはみ出しを見つけるためにそのまま残す。
- `navigation.spec.ts` のこのテストの `page.setViewportSize({ width: 390, height: 844 })` は、`chromium` で回すときのために残す。

### CI（決定事項3）
- `.github/workflows/e2e.yml` の `playwright install --with-deps chromium` を `chromium webkit` にする。`pnpm e2e` は今のまま（全プロジェクトが回る）。
- ジョブは1つのまま分けない。`timeout-minutes` は今の30分のまま。実装PRで CI の時間を測り、PR の説明に書く。
- 落ちたときのレポートの保存（`playwright-report`）は今のまま。

### ローカル
- `pnpm e2e` は全プロジェクトを回す。WebKit が入っていないと `iphone` のプロジェクトが落ちるので、最初に `pnpm exec playwright install webkit` を実行する（Linux では `--with-deps`）。
- Chromium だけで回すときは `pnpm e2e --project chromium`。
- 上の手順を `e2e-testing` スキル（`.claude/skills/e2e-testing/SKILL.md`）に書く。

## 認可と秘匿
- 閲覧者IDの使い方：変えない。
- 他人のデータに届かないことの保証：変えない。テスト用ログイン（`POST /__e2e__/login`）は今までどおり E2E の環境でだけ使う。
- 区別させない応答：変えない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] Playwright の設定：`iphone` のプロジェクトがあり、WebKit（`defaultBrowserType` が `webkit`）で、`grep` が `@iphone` になっている。`release.spec.ts` を回さない。`chromium` と `release` は変わっていない（設定を import して確かめる。Vitest）。
- [ ] 印の付け忘れの検査：上の表のテストに `@iphone` が付いている（`e2e/*.spec.ts` を読み、テストの名前と印を確かめる。Vitest）。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 上の表のテストが、`iphone`（WebKit）と `chromium` の両方で通る。
- [ ] 募集の作成のシートで、日付・開始・終了の入力欄がシートの右端を越えない（`iphone` と `chromium`）。

## スコープ外
- すべての E2E を WebKit で回すこと（CI の時間が倍になる）。
- Firefox・Android の Chrome・本物の iPhone（実機・クラウドの端末）でのテスト。
- スクリーンショットの差分の比較。
- WebKit で見つかった不具合のアプリの修正（別のタスク）。
- T-20（PC の配置）の「スマホ」と「PC」の2つの大きさで回すプロジェクト。T-20 の実装PRで、`iphone` のプロジェクトとの関係を決める。

## 決定事項（仕様書PRのレビューで合意する）
1. WebKit は `devices["iPhone 13"]` の1つのプロジェクトで回す。（提案）
2. WebKit で回すのは `@iphone` の印を付けたテストだけにし、ログイン・シート・誘い〜成立・募集〜決定の流れに絞る。（提案。CI の時間を抑えるため）
3. CI は今の E2E のジョブの中で WebKit も回し、ジョブを分けない。（提案）

## 確認事項（合意前に解消する）
- Linux の WebKit で、iPhone の Safari の日付の入力欄のはみ出しが再現するか。実装PRで確かめ、再現しなければ上の「T-11 の入力欄のはみ出しの確認」のとおりにする（仕様書PRのマージは止めない）。
- WebKit で、`http://localhost` の更新用トークンの Cookie（`Secure` 付き）が送られるか。送られないと WebKit ではログインが続かない。実装PRで確かめ、送られないときはテスト用の環境だけで回避する方法を仕様書に足してから実装する。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 初版 | 利用者の依頼（pryusei/kokohima-app#139 のレビューで、iPhone のはみ出しは Chromium の E2E では再現しないと指摘された） |
