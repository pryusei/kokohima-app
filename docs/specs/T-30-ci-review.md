# T-30 仕様書：CI の見直し（テストを回すタイミングと中身）

- 状態：下書き
- タスク票：docs/tasks/T-30-ci-review.md
- 関係する要件：要求定義書「技術」の CI。CLAUDE.md「テスト」「仕様書とPRの流れ」。T-21（docs/specs/T-21-webkit-e2e.md）

## 概要
- 2026-11-23 に、GitHub Actions の直近の実行（40回）とワークフローを見直した。見つかったことは次の6つ。
  1. 実装PRに単体テストを求める検査（`require-unit-tests`）が `feat/*` のブランチでしか動かない。直近の実装PR 21本のうち16本（`claude/*` が14本、`fix/*` が2本）で、検査が飛ばされていた。Claude Code のクラウドのセッションはブランチ名が `claude/…` になるので、名前で判定する方式は効かない。
  2. PR のブランチに push するたびに、ci が2本（`push` と `pull_request`）走る。1本は約3分。仕様書だけの PR でも、ci と E2E を全部回している。
  3. E2E は main への PR でしか回らず、マージした後の main では回らない。同じブランチの PR が数分おきに続けてマージされることがあり（#172 → #173 → #174 が11分の間）、マージ後の組み合わせを E2E で確かめていない。
  4. E2E の準備の `playwright install --with-deps` は普段40〜80秒だが、1回は15分45秒かかった（E2E 全体で18分）。ログを見ると、OS の依存パッケージ（apt）の取得が `Fetched 140 MB in 14min 46s (158 kB/s)` で、ブラウザの取得は合わせて10秒ほどだった。
  5. `e2e/navigation.spec.ts` の「お知らせのリンクのように誘いの URL を直接開いて閉じると…」（`@iphone`）が、WebKit で、見た4回のうち2回 flaky だった。CI はリトライ（2回）で通るので緑になり、気づけない。
  6. terraform の `fmt -check` と `validate` が、秘密を使う `plan` と同じジョブにあり、承認を待つまで回らない。
- これらを、ワークフロー・E2E の設定・テストの待ち方だけで直す。アプリ（`apps/web`・`apps/api`）の振る舞いは変えない。ただし flaky の原因がアプリにあったときは、下の「5. flaky の修正」のとおりにする。

## API
変えない。

## データ
変えない（マイグレーションなし）。

## 振る舞い

### 1. 変更の分類（`scripts/ci/changes.mjs`）
- PR の差分（`git diff --name-status -M origin/<宛先>...HEAD` の行）を受け取り、次の3つを返す Node のスクリプトを足す。判定の関数を export し、単体テストで確かめる。
  - `docsOnly`：変更がすべて文書のとき true。文書とは、`docs/` の下のファイルと、`apps/`・`packages/`・`e2e/`・`scripts/` の外にある `.md`（`CLAUDE.md`、`.claude/skills/**/*.md`、`.github/pull_request_template.md` など）。差分が空のときは false にする（念のため回す）。
  - `needsUnitTest`：追加・変更・名前の変更（A・M・R）のファイルのうち、`apps/`・`packages/`・`scripts/` の下にあり、`.md` でも `package.json` でもないものが1つでもあれば true。消しただけ（D）は数えない。名前の変更は移動先のパスで判定する。
  - `hasUnitTest`：追加・変更・名前の変更のファイルに単体テストが1つでもあれば true。単体テストとは、`apps/`・`packages/`・`scripts/` の下の `*.test.ts`・`*.test.tsx` と、`e2e/` の下の `*.unit.ts`。消したテストは数えない。
- 文書を飛ばしてよい根拠：単体テスト・E2E・本番のビルドは、`docs/` と `.md` を読まない。2026-11-23 に、テストと設定が `readFileSync`・`?raw`・`import.meta.glob`・`define` で読むファイルと、本番のビルドの検査（`apps/api/scripts/`）を確かめた。パッケージの外で読んでいるのは `infra/terraform/envs/prod/waf.tf`（WAF のテスト）だけで、これは文書に入らないので回る。テストやビルドで `docs/` や `.md` を読むようにするときは、この分類も直す。
- Dependabot の依存の更新（`package.json` と `pnpm-lock.yaml` だけ）は、`docsOnly` も `needsUnitTest` も false になる。テストは回り、単体テストの追加は求めない。
- `infra/`・`.github/`・`e2e/` とルートの設定ファイルだけの変更にも、単体テストの追加は求めない（検査の対象外）。テストが要るかは、その仕様書のテスト計画とレビューで決める。

### 2. ci（`.github/workflows/ci.yml`）
- 回すタイミング：
  - `pull_request`（宛先のブランチを問わない）と、`main` への `push`。main 以外のブランチへの push だけでは回さない。PR を作れば回る。
  - 同じ PR に新しい push が来たら、その PR の古い実行は取り消す（`concurrency` の `cancel-in-progress`）。main への push はコミットごとに別のグループにし、取り消さない（マージごとに確かめる）。
- ジョブ：
  - `changes`（新規）：PR のときだけ、上の分類の `docsOnly` を出す。秘密は使わない。
  - `unit`（名前は変えない）：型チェック・lint・単体テスト・本番のビルド（`build:prod`）。中身は変えない。`changes` が成功して `docsOnly` が true のときだけ、ジョブの `if:` で飛ばす。`changes` が失敗・取り消しになったときは飛ばさずに回す（判定の失敗で検査が抜けないように、回す側に倒す）。main への push では常に回す。
  - `require-unit-tests`（名前は変えない）：すべての PR で回す（`feat/*` の条件をなくす）。自分で差分を取って上の分類を使い、`needsUnitTest` が true で `hasUnitTest` が false なら「実装PRには単体テスト（*.test.ts）の追加・変更が必要です」で落とす。`changes` には頼らない（`changes` が失敗したときに、この検査が飛ばされないように）。
- 文書だけの変更は、ワークフローの `paths-ignore` ではなく、ジョブの `if:` で飛ばす。`paths-ignore` だとワークフローが動かず、必須チェックにしたジョブが「待機中」のまま止まって、マージできなくなるため。ジョブを `if:` で飛ばした場合は、必須チェックを満たした扱いになる。
- ジョブの名前（`unit`・`require-unit-tests`）を変えないのは、ブランチ保護の必須チェックの名前と合わせるため。

### 3. E2E（`.github/workflows/e2e.yml`）
- 回すタイミング：
  - main への `pull_request`（今のまま）
  - main への `push`（新規。マージした後の main を確かめる）
  - 手動（`workflow_dispatch`。新規）
- `concurrency` は ci と同じにする（PR は古い実行を取り消し、main はコミットごとに回す）。
- ジョブ：
  - `prepare`（新規）：PR のときは上の分類の `docsOnly` を出す。あわせて、`pnpm-lock.yaml` で解決した `@playwright/test` の版（例：`1.65.0`）を出す（`scripts/ci/playwright-version.mjs`）。秘密は使わない。
  - `e2e`（名前は変えない）：飛ばす条件は ci の `unit` と同じ（`prepare` が成功して `docsOnly` のときだけ飛ばす）。
- `e2e` は Playwright の公式のコンテナ（`mcr.microsoft.com/playwright:v<版>-<Ubuntu の名前>`）の中で回す。
  - 版は `prepare` が出した版を使い、`pnpm-lock.yaml` と常に一致させる。Dependabot が Playwright を上げても、ワークフローを直さずに済む。
  - `playwright install --with-deps` はやめる。OS の依存とブラウザ（Chromium・WebKit）はコンテナに入っている。
  - Chromium のために、コンテナに `--ipc=host` を付ける（Playwright の Docker の案内のとおり）。
  - Ubuntu の名前（`noble` など）は、実装PRで、その版に出ているタグを確かめて決める。
  - ブラウザのキャッシュは使わない。遅かったのは OS の依存の取得で、ブラウザの取得は速かったため（概要の4.）。
- main への push の E2E が落ちたら、GitHub の通知（そのコミットをした人）で気づく。直す PR をほかの PR より先に出す。
- 落ちたときのレポートの保存（`playwright-report`、7日）は今のまま。`timeout-minutes` は30分のまま。

### 4. flaky の扱い（`playwright.config.ts`）
- CI では、flaky（1回落ちて、リトライで通った）のテストがあれば E2E を落とす（`failOnFlakyTests: isCI`。Playwright 1.65.0 にある設定）。
- CI のリトライは2回から1回にする（`retries: isCI ? 1 : 0`）。リトライは、落ちたテストが flaky か壊れているかを分け、トレース（`trace: "on-first-retry"`）を取るために残す。flaky も落とすので、2回目のリトライは要らない。
- ローカルは今のまま（リトライなし）。

### 5. flaky の修正（`e2e/navigation.spec.ts`）
- 対象：「お知らせのリンクのように誘いの URL を直接開いて閉じると、アプリの外に出ず誘いタブへ移る」（`@iphone`）。
- 落ち方：B が誘いの URL を直接開き、シートが見えてから Esc を押しても、URL が `/invites/<id>` のままでシートが閉じない。`toHaveURL(/\/invites$/)` が5秒で切れる。WebKit だけで出て、リトライでは通る。
- 考えられる原因：シートが見えた時点では、Esc を受ける処理（`apps/web/src/ui/BottomSheet.tsx` の `useEffect` で文書に付ける `keydown`）がまだ付いていない。直接開くと、ログインの取り直しと誘いの取得が重なり、WebKit ではその間が長くなる。
- 実装PRでは、WebKit で `--repeat-each` を使って繰り返し回し、原因を確かめてから直す。
  - 原因が上のとおりなら、テストを直す。Esc を押す前に、シートにフォーカスが入ったこと（`toBeFocused()`）を待つ。フォーカスを移すのは Esc を受ける処理を付けるのと同じ effect の中なので、これを待てば Esc が効く。利用者にも見える状態（キーボードの利用者はシートの中から操作を始める）を待つので、固定の wait にはしない。
  - 原因がアプリにあり、利用者の操作でも起きるとき（シートが付け直されて、Esc が効かない時間がある、など）は、アプリを直し、T-11 の仕様書（docs/specs/T-11-design.md）も同じ PR で直す。
- 直したあと、`navigation.spec.ts` を WebKit で `--repeat-each 20` で回し、落ちないことを確かめる。結果は PR に書く。
- ほかの Esc でシートを閉じるテスト（`e2e/fixtures.ts` の `addAvailability`、`availability.spec.ts`、`friends.spec.ts`、`desktop.spec.ts`）は、シートの中の操作の結果を待ってから Esc を押しているので変えない。flaky が出たら、同じ方法で直す。

### 6. terraform（`.github/workflows/terraform.yml`）
- 回すタイミングは今のまま（`infra/**` を変えた、main への PR）。
- ジョブを2つに分ける。
  - `check`（新規）：秘密を使わず、承認も待たない。`terraform fmt -check -recursive infra/terraform` を1回と、`staging`・`prod` のそれぞれで `terraform init -backend=false` と `terraform validate`。
  - `plan`（名前は変えない）：`check` が通ってから回す。承認（環境 `terraform-plan`）のあとに、今と同じ `init`（R2 の状態）と `plan`。`fmt` と `validate` は `check` に移したので外す。
- これで、整形と検証の誤りが承認を待つ前にわかる。秘密を使う `plan` は、今と同じく承認のあとだけ。

### 7. 文書の更新（実装PRで一緒に直す）
- `CLAUDE.md`「テスト」の「CIはpushごとに型チェック・lint・単体テスト、mainへのPRでE2Eを実行する」を、新しいタイミングに直す。PR ごとと main への push で型チェック・lint・単体テスト、main への PR と main への push で E2E を回すこと、文書だけの変更では飛ばすこと、CI では flaky も落ちることを書く。
- `CLAUDE.md`「進め方」に、単体テストの検査はブランチ名ではなく差分で判定すると書く。ブランチ名の決まり（`spec/T-xx`・`feat/T-xx`）そのものは変えない。
- `.claude/skills/e2e-testing/SKILL.md`：CI は Playwright のコンテナで回すこと、CI では flaky も落ちること、その直し方（見えただけでなく、操作を受けられる状態を待つ）を書く。
- `docs/specs/T-21-webkit-e2e.md`「CI」：`playwright install --with-deps chromium webkit` の記述を、コンテナで回す形に直し、変更履歴に1行足す。

## 認可と秘匿
- 閲覧者IDの使い方：変えない。
- 他人のデータに届かないことの保証：変えない。テスト用ログイン（`POST /__e2e__/login`）は、今までどおり E2E の環境でだけ使う。本番のビルドの検査（`build:prod`）は `unit` に残す（要求定義書の「CIで本番のビルドにテスト用の経路が含まれていないことを確認する」）。
- 区別させない応答：変えない。
- ワークフローの権限は今のまま `contents: read`。新しいジョブ（`changes`・`prepare`・`check`）は秘密を使わない。E2E はコンテナにしても秘密を使わない（テスト用の鍵は、今までどおりその場で生成する）。terraform の秘密は、今と同じく承認のあとの `plan` だけで使う。
- アクションは今までどおりコミットの SHA で固定する。コンテナのイメージは版のタグで指定し、SHA（ダイジェスト）では固定しない（決定事項4）。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 変更の分類（`scripts/ci/changes.test.ts`。ルートの `vitest.config.ts` に `ci` のプロジェクトを足す）：
  - [ ] `docs/` だけ、または `.md` だけ（`CLAUDE.md`、`.claude/skills/x/SKILL.md`）→ `docsOnly`
  - [ ] `apps/` の下の `.md`、`infra/terraform/envs/prod/waf.tf`、`.github/workflows/ci.yml`、`pnpm-lock.yaml` のどれかが混じる → `docsOnly` でない
  - [ ] 差分が空 → `docsOnly` でない
  - [ ] `apps/api/src/x.ts` を変えて、テストがない → `needsUnitTest` が true で `hasUnitTest` が false
  - [ ] `apps/api/src/x.test.ts`、`apps/api/test/y.test.ts`、`apps/web/src/z.test.tsx`、`e2e/w.unit.ts`、`scripts/ci/v.test.ts` のどれかを足す・変える → `hasUnitTest`
  - [ ] テストを消しただけ（D）→ `hasUnitTest` でない
  - [ ] コードを消しただけ（D）→ `needsUnitTest` でない
  - [ ] 名前の変更（`R100` の行。移動元と移動先の2つのパス）→ 移動先のパスで判定する
  - [ ] `apps/web/package.json` と `pnpm-lock.yaml` だけ（Dependabot）→ `needsUnitTest` も `docsOnly` も false
  - [ ] `e2e/x.spec.ts` だけ → `needsUnitTest` でない（E2E だけの変更）
- [ ] Playwright の版（`scripts/ci/playwright-version.test.ts`）：`pnpm-lock.yaml` のルートの `@playwright/test` の版を返す。見つからないときはエラーで止める（違う版のコンテナで回さない）。
- [ ] ワークフローの設定（`scripts/ci/workflows.test.ts`。YAML を読んで確かめる。読むために `yaml` を開発用の依存に足す）：
  - [ ] ci：`push` は `main` だけ、`pull_request` は宛先を絞らない。`concurrency` は PR だけ取り消す。`unit` は `changes` が成功して `docsOnly` のときだけ飛ぶ。`require-unit-tests` にブランチ名の条件がない。`unit` が `build:prod` を回す。
  - [ ] e2e：`pull_request`（main）・`push`（main）・`workflow_dispatch` で回る。`e2e` はコンテナで、イメージの版は `prepare` の出力を使い、`--ipc=host` を付ける。`playwright install` を実行しない。飛ぶ条件が ci の `unit` と同じ。
  - [ ] terraform：`check` は `environment` を持たず、秘密（`secrets.`）を参照しない。`plan` は `needs: check` と `environment: terraform-plan` を持つ。
  - [ ] すべてのワークフロー：`uses:` が40桁の SHA で固定されている。`permissions` が `contents: read` だけ。
- [ ] Playwright の設定（`e2e/playwright-config.unit.ts` に足す）：CI のとき `failOnFlakyTests` が true で `retries` が1。CI でないときは `failOnFlakyTests` が false で `retries` が0。

### E2Eテスト（対象にする利用者の流れ）
- [ ] 「お知らせのリンクのように誘いの URL を直接開いて閉じると…」が、`iphone`（WebKit）で `--repeat-each 20` で回しても落ちない。`mobile` でも通る。
- 新しい利用者の流れは足さない。変えるのは CI と、テストの待ち方だけ。

### CI での確かめ（実装PRで行い、PR の説明に書く）
- [ ] 実装PRで、ci と E2E がそれぞれ1本ずつだけ走る（push の分が走らない）。
- [ ] `claude/*` のブランチの実装PRで、`require-unit-tests` が回って通る。
- [ ] コンテナで回した E2E の所要時間を、今（3〜4分）と比べる。
- [ ] マージ後：main への push で ci と E2E が回る。マージ後の最初の仕様書PRで、`unit` と `e2e` が飛ばされ、マージできる。

## スコープ外
- 単体テストのジョブの分割（型チェック・lint・テストを別のジョブにする）。今は ci 全体が約3分で、単体テストが1分45秒。分けても、ジョブごとの準備に約40秒かかるので、あまり縮まない。
- カバレッジの計測。
- E2E の毎晩の実行（main への push で回すので要らない）。
- 「他人のIDでは取得・更新できないテスト」の機械的な検査。今の運用（PR のチェックボックスと `security-reviewer` サブエージェント）のまま。
- ブランチ保護の設定の変更（GitHub の Settings。人が行う。下の確認事項）。
- マージキュー（merge queue）。
- Dependabot の jsdom の更新の失敗（`update_not_possible`。別の作業）。

## 決定事項（仕様書PRのレビューで合意する）
1. ci は PR と main への push で回し、main 以外のブランチへの push だけでは回さない。（利用者と決めた。2026-11-23）
2. E2E は main への PR に加えて、main への push でも回す。（利用者と決めた。2026-11-23）
3. 単体テストの検査は、ブランチ名ではなく差分で判定する。（利用者と決めた。2026-11-23）
4. E2E は Playwright の公式のコンテナで回し、イメージの版は `pnpm-lock.yaml` の `@playwright/test` に合わせる。（提案。見直しの時点では「ブラウザのキャッシュ」を提案したが、ログで遅いのは OS の依存の取得だとわかったので変えた。ほかの案として、apt の `.deb` を Actions のキャッシュに置く方法がある。ランナーの版が変わるたびにキャッシュが効かなくなり、仕組みも込み入るので採らない。イメージを SHA で固定しないのは、版を lockfile から決めるためで、今も同じ提供元（Playwright の配布と Ubuntu のミラー）からブラウザと依存を取っているので、信頼する範囲は広がらない）
5. 文書（`docs/` と `.md`）だけの変更では、`unit` と `e2e` をジョブの `if:` で飛ばす。判定に失敗したときは回す。（提案）
6. CI では flaky を失敗にし、リトライを1回にする。（提案）

## 確認事項（合意前に解消する）
- ブランチ保護の必須チェックに、今どれが入っているか（`unit`・`require-unit-tests`・`e2e`）。この作業環境からは見えない。この仕様ではジョブの名前を変えないので、今の設定はそのまま効く。`require-unit-tests` が必須になっていなければ、実装PRのマージ後に必須チェックに足すのがよい（GitHub の Settings → Branches で、利用者が行う）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 初版 | 利用者の依頼（GitHub Actions の見直し：テストを回すタイミングと中身） |
