# T-56 仕様書：UIの「動き」と「手触り」

- 状態：仕様書
- タスク票：docs/tasks/T-56-motion.md
- 関係する要件：要求定義書「デザイン原則」（断り・期限切れ・キャンセルを赤やエラー色で出さない）、アクセシビリティ（動き・フォーカス）
- 関係する仕様書：T-11（docs/specs/T-11-design.md。画面のつながり・シート・読み込み中）、T-20（docs/specs/T-20-desktop-layout.md。PC のナビとダイアログ）、T-43（docs/specs/T-43-meet-moment.md。成立の演出）、T-54（docs/specs/T-54-save-and-goodbye-copy.md。保存のボタン）、T-40（docs/specs/T-40-ima-hima.md。今ひまの「元に戻す」）、T-55（ここ暇タブの週の帯。作業中のブランチ `feat/T-55-availability-week-grid`）、T-46（フォーカスの輪）

## 概要
画面（`apps/web`）の動きは、今は成立の演出（T-43）と、ボタンの `active:scale-[.98]`・スイッチの既定の transition だけで、シートは「パッ」と出て消え、送った・成立した・追加したという手応えがどこにも出ない。持ち主の指示書（スマホの幅 390×844 で触って確かめた20の指摘）をもとに、アプリ全体の動きを、動きのトークンと少数の部品（`useExitAnimation`・`Collapse`・結果の帯など）でそろえる。依存は増やさず、CSS と View Transitions API で作る。

この仕様書の指摘の根拠は、スクリーンショットではなくコードの場所で書く（持ち主の手元の `.reports/ui-motion/` はリポジトリにない）。各項目の「今」は、この仕様書を書いた時点の main（c21c1a2）で確かめた。

## API
変えない。新しい経路も作らない。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| （なし） | | | | | |

## データ
- サーバー：なし（マイグレーションなし）。
- 端末：新しく保存するものはない。タブごとのスクロールの位置（M-07）、灯りをともした枠（M-12）、新しく増えた行の印（M-10）は、どれも JavaScript のメモリだけに持ち、localStorage・sessionStorage には置かない。ブラウザの履歴の印（`history.state`）に足すのは、深さ（`depth`、M-13）とエントリの印（`key`、M-07。中身のない無作為の文字列）だけで、個人の情報・ID・位置は入れない。成立の演出の「見た」の記録は T-43 の `kokohima.meetMomentSeen` をそのまま使い、増やさない。プライバシー ポリシーは変えない。

## 振る舞い

### 0. 全体の決まり

#### 0-1. このアプリ固有の決まり（破らない）
1. **断り・期限切れ・キャンセルを、赤・揺れ・✕の演出で出さない**。「今回は難しい」・見送り・期限切れ・締め切り・やっぱり難しい・失敗は、静かに薄くなる（フェード・影が消える）だけ。
2. **色の役割を動きでも守る**：灯りの黄色（`lamp` 系）は「自分と重なるここ暇の枠」「ここ暇を作る・募るボタン」「未読の印」だけ。成立は青緑（`meet` 系）だけ。紙吹雪などで黄色をばらまかない。下のタブ・左のナビの「今いる場所」の印にも黄色を使わない（M-07）。
   - 例外：T-43 の成立の演出（灯りの色の丸が寄って重なり、青緑に変わる）は、2人それぞれの灯り（ここ暇）が重なることを表す、持ち主が選んだ演出なので、そのまま残す（下の M-04）。
3. **見せない相手と暇がない相手を、動きで区別させない**（CLAUDE.md「セキュリティ」）。
   - 友達のここ暇が見えなくなった（見せないにされた・取り消された・暇がない）ことを、特別な退場の動きで見せない。友達の側のデータ（みんなタブ、友達の詳細の行きたい、受信の一覧）の行の出入りには動きを付けない。
   - 読み込みの時間差を演出で目立たせない。骨組みの数と形は、件数や相手によって変えない（M-06）。
   - 募集の応答者の有無を動きで匂わせない。募集の人数（`HeadCount`）の増減、「締め切りました」、募集の宛先の人の画面には、新しい動きを付けない。成立の動き（M-04）は、T-43 と同じく予定の参加者（`meetupId` を受け取った人）にだけ出る。
4. **`prefers-reduced-motion: reduce` では動きを止める**。CSS の動きは `apps/web/src/index.css` の末尾の共通の指定（すべての `transition` と `animation` を `none !important`）で止まる。JavaScript で動きの終わりを待つところ・View Transitions・`element.animate()`・`scrollTo({ behavior: "smooth" })` は、この共通の指定では止まらないので、`prefersReducedMotion()`（下の 0-3）で確かめて即時にする。**終わりの動きを `animationend`・`transitionend` だけで待つ作りにしない**（この設定と jsdom では届かず、永遠に終わらない）。
   - **入る動き（`animation`）は、止まった状態の見た目を最終形にする**。要素の普段の指定は `opacity: 1`・`transform: none` のままにし、`opacity: 0` などの始まりの形はキーフレームの `from` にだけ書いて、`animation-fill-mode: backwards`（遅れ `animation-delay` の間も `from` を保つ）で付ける。共通の指定で `animation: none` になっても最終形が見える。普段の指定に `opacity-0` を置き、動きで 1 にする作りは禁止（動きを止める設定の利用者には、骨組み・空の状態・結果の帯がずっと見えなくなる）。M-06 の骨組み・M-19 の空の状態・`FadeIn`・M-09 の結果の帯・M-12 の灯り・M-15 のぽんのすべてに当てはまる。
   - `@starting-style` で書く入る動き（M-01 のシートなど）は、もともと普段の指定が最終形なので、この形になっている。
5. 色・角丸・影はトークン（`bg-surface`、`shadow-sheet` など）だけ。Tailwind の既定の色は書かない（`apps/web/src/ui/colors.test.ts` の検査のまま）。長さと曲線は下の動きのトークンだけで書き、`duration-300` などの直書きを散らさない。
   - 今あるものも移す：`Button` と今ひまのボタン（`availability/FreeNowCard.tsx`）の `transition-transform`（Tailwind の既定の 150ms と曲線）は `duration-(--duration-press) ease-out` にする。`Switch` は M-18。T-55 の `kh-pop`・`kh-rise`（`animate-[kh-pop_.35s_ease-out]` など）は M-09 のとおりトークンにする。
   - **例外**：T-43 の成立の演出（`index.css` の `.kh-meet-dot`・`.kh-meet-pair`・`.kh-meet-reveal` と `kh-meet-*` のキーフレーム。1200ms・1300ms・`cubic-bezier(.45,0,.25,1)` など）は、T-43 の決めた長さと曲線のまま残し、トークンに置き換えない（M-04「変えないこと」）。直書きの検査（下のテスト計画）では、この3つのクラスとキーフレームだけを除く。
6. 依存を増やさない（「判断してほしいこと」1）。CSS（`@starting-style`、`transition-behavior: allow-discrete`、`linear()` のばねの曲線）と View Transitions API（Chrome 111 以降・Safari 18 以降）で作る。使えない端末では即時に切り替わるだけでよい。指につく引っぱり（M-02）だけは小さな自前のフックで書く。
   - `height: auto` への transition（`interpolate-size`）は Chromium にしかなく、Safari・Firefox では動かず元の高さのまま止まってから一気に変わるので、**使わない**。高さを動かすところは、`Collapse`（`grid-template-rows`）か、JavaScript で測った px から px への transition（M-03）で書く。
7. 動かすのは `transform` と `opacity` が基本。高さの開閉は `grid-template-rows: 0fr ↔ 1fr`（`Collapse`。下の 0-4）で書く。

#### 0-2. 動きのトークン
`apps/web/src/index.css` に置き、すべての動きをこれで書く。

| 名前 | 値 | 使う所 |
| --- | --- | --- |
| `--duration-press` | 100ms | 押した瞬間の縮み・色。`fast` で入る動きの出る動き |
| `--duration-fast` | 160ms | フェード、小さな移動、タブの切り替え。`base` で入る動きの出る動き |
| `--duration-base` | 240ms | 一覧の行の出入り、切り替えの帯、結果の帯。`sheet` で入る動きの出る動き |
| `--duration-sheet` | 360ms | シートが出る、バッジの「ぽん」 |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` | 入ってくる動き |
| `--ease-in` | `cubic-bezier(.4,0,1,1)` | 出ていく動き |
| `--ease-spring` | `linear(0, 0.13 4%, 0.44 10%, 0.75 17%, 0.94 25%, 1.03 34%, 1.045 40%, 1.03 50%, 1.01 62%, 1 75%, 1)`（4.5%だけ行き過ぎて戻る） | シート、バッジの「ぽん」、ばねで戻る、スイッチのつまみ |

- `--ease-*` は Tailwind v4 の `@theme` の `ease` の名前空間に置き、`ease-out`・`ease-in`・`ease-spring` のクラスで使う（Tailwind の既定の `ease-out`・`ease-in` は上の値で上書きする）。
- `--duration-*` は Tailwind v4 に名前空間がないので、`@theme static`（使っていなくても CSS 変数として出す）に置き、`duration-(--duration-fast)` のように任意値で使う。
- `linear()` を使えない端末では `--ease-spring` を `--ease-out` にする（`@supports not (transition-timing-function: linear(0, 1))`）。
- JavaScript から長さを使うところ（`useExitAnimation` の保険のタイマーなど）のために、同じ値を `apps/web/src/ui/motion.ts` の `MOTION_MS`（`{ press: 100, fast: 160, base: 240, sheet: 360 }`）に置く。CSS と値がずれないことを単体テストで確かめる。
- **出る動きは入る動きの約7割の長さにする**（iOS・Material と同じ）。トークンでは「入る動きの1段下」を使う：`sheet`(360)で入るものは `base`(240)で出る、`base`(240)で入るものは `fast`(160)で出る、`fast`(160)で入るものは `press`(100)で出る。出る動きの曲線は `--ease-in`。
  - 指示書の叩き台では、シートの出る動きを `--duration-fast`（160ms）にしていたが、この決まりにそろえて `--duration-base`（240ms）にする（叩き台と違うので「判断してほしいこと」11 に並べる）。E2E は Playwright が要素の消えるのを待つ（`toHaveCount(0)` は既定の待ち時間の中で何度も確かめる）ので、240ms でも通る。

#### 0-3. 動きの部品（`apps/web/src/ui/motion.ts` ほか）
- `prefersReducedMotion(): boolean`：`window.matchMedia("(prefers-reduced-motion: reduce)").matches`。`matchMedia` がない環境（jsdom の既定）では **true**（＝即時）を返す。動きを確かめるテストだけ、`matchMedia` を差し替えて false にする。
  - **`matchMedia` を差し替えている既存のテストは、そのままでは「動きあり」になる**。`apps/web/src/ui/navigation.test.tsx` の `stubMatchMedia`（PC の幅の問い合わせ以外にすべて `matches: false` を返す）、`apps/web/src/pages/contact.test.tsx`（PC の幅の問い合わせだけ true）、`apps/web/src/install/install.test.tsx` の `stubMatchMedia`（`display-mode: standalone` 以外は false）がそれで、たとえば navigation.test.tsx の「PC の配置では、つまみを隠し（lg:hidden）、右上の『閉じる』で閉じる」は、M-01 を入れると保険のタイマーまで `onClose` が呼ばれず落ちる。実装PR①で、この3つの差し替えを **`(prefers-reduced-motion: reduce)` の問い合わせには `matches: true` を返す**ように直す（動きを確かめるテストは、そのテストの中で false を返す差し替えを使う）。実装PR②・③で新しく `matchMedia` を差し替えるテストも同じにする。
  - 判定の決め方をアプリの中でそろえる：`apps/web/src/pages/SettingsPage.tsx` の新しい端末のログインから開いたときの `scrollIntoView` の判定（今は「`matchMedia` がなければ reduce ではない」）を `prefersReducedMotion()` に置き換える（jsdom では `behavior: "auto"` になる。既存のテストは `scrollIntoView` が呼ばれたことだけを見ているので、引数を見ているなら合わせて直す）。
- `useExitAnimation(durationMs)`：出る動きを走らせてから、本当に消す（閉じる・外す）ためのフック。
  - 返すもの：`{ exiting: boolean; start(done: () => void): void; cancel(): void; ref }`。`exiting` が true のあいだ、呼び出し側は出る動きのクラス（`data-exiting`）を付ける。
  - `start(done)`：
    - すでに出る動きの途中なら、何もしない（**二度押しで `done` が2回にならない**。シートでは `history.back()` が2回にならない）。
    - `prefersReducedMotion()` が true なら、その場で `done()` を1回呼ぶ（即時）。
    - それ以外は `exiting` を true にし、`ref` の要素自身の `transitionend`・`animationend`（子の要素から泡立ってきたものは数えない）か、保険のタイマー（`durationMs + 50ms`）の早いほうで `done()` を1回だけ呼ぶ。`durationMs` には、その部品の出る動きのうち**一番長いもの**を渡す。`ref` は、その一番長い動きをする要素に付ける（短い動きの要素に付けると、そちらの `transitionend` で先に `done` が呼ばれる）。
  - `done()` を呼んだあと（タイマーとイベントを外したあと）、`exiting` は false に戻る。同じ部品で、また `start` できる（`Collapse`・M-15 の未読のバッジ・M-10 のように、同じ要素が閉じて開いてまた閉じる使い方のため）。
  - `cancel()`：出る動きの途中なら、タイマーとイベントを外し、`done()` を呼ばずに `exiting` を false に戻す（元の見た目へ戻る）。途中でなければ何もしない。`Collapse` は、閉じる途中で `show` が true に戻ったら（M-04・M-10 の、送れなかったときの戻し。応答が出る動きより早く失敗したとき）`cancel()` を呼び、中身を消さない。
  - 出る動きの途中でアンマウントされたら（ブラウザの戻るで URL が先に変わったときなど）、タイマーを止め、`done()` は呼ばない（呼ぶと戻るが2回になる）。
- `useViewTransition`（`apps/web/src/router.ts` の中）：View Transitions を使う画面の切り替え（M-07・M-13）。`document.startViewTransition` がない・`prefersReducedMotion()` が true なら、更新をそのまま行う（即時）。ある場合は、更新の関数の中で React の `flushSync` で描き切る。

#### 0-4. 高さの開閉の部品 `Collapse`（`apps/web/src/ui/Collapse.tsx`）
- `<Collapse show={boolean}>…</Collapse>`：`display: grid` の入れ物の `grid-template-rows` を `0fr ↔ 1fr`、中身の `opacity` を `0 ↔ 1` にする。中の要素は `min-height: 0; overflow: hidden`。
- 開く：`--duration-base`・`--ease-out`。閉じる：`--duration-fast`・`--ease-in`。閉じる動きのあいだは中身を描き続け、終わったら描かない（`useExitAnimation`）。
- 最初の描画で `show` が true のときは動かさない（開いた状態で出る）。動かすのは、描いたあとで `show` が変わったときだけ。
- 閉じている途中と閉じたあとは、中身を `inert` にする（Tab で入らない・読み上げない）。
- 使う所：M-04 のボタン群の退場、M-10 の行の出入り、オフラインの帯（見た目の崩れ V-2）、M-09 で押した場所の近くから消える部品。

### 1. 実装PR①：土台とシート（動きのトークン、`useExitAnimation`、M-01、M-02、M-16）

#### M-01 シートの出入り
- **今**：`apps/web/src/ui/BottomSheet.tsx` に出入りの動きがない。暗幕（`data-testid="sheet-scrim"`、`bg-scrim`）とシート（`role="dialog"`）は、描いた瞬間に完成形で、`onClose` を呼ぶとすぐ消える（`SheetScreen` は `goBack(parent)`）。PC（`lg:`）の中央のダイアログも同じ。
- **振る舞い**：
  - **暗い背景を別の層にする**：今は `bg-scrim` が暗幕（`sheet-scrim`）の要素そのものに付いていて、シートはその子なので、暗幕の `opacity` を下げるとシートも一緒に薄くなる。暗い背景は、暗幕の中にシートより後ろの別の要素（`absolute inset-0 bg-scrim`、`aria-hidden`、`data-testid="sheet-backdrop"`）として置き、薄くする・濃さを変える（M-02）のはこの層だけにする。暗幕の要素（`sheet-scrim`）は、今の押し始めと離しの判定（暗い部分を押して離したときだけ閉じる）の受け口のまま残す（背景の層は `pointer-events: none`）。
  - 入る（スマホ）：シートは `translateY(100%) → 0`（`--duration-sheet`・`--ease-spring`）、暗い背景の層は `opacity 0 → 1`（`--duration-fast`・`--ease-out`）。`@starting-style` で書き、React の状態は使わない。
  - 入る（PC、幅1024px以上）：下からではなく `scale(.96)`＋`opacity 0` → `scale(1)`＋`opacity 1`（`--duration-base`・`--ease-out`）。暗幕はスマホと同じ。
  - 出る：「閉じる」のボタン・暗幕・`Esc`・つまみ（M-02 の閉じる判定を含む）のどれで閉じても、`onClose` をすぐ呼ばず、`useExitAnimation` で出る動きを走らせてから `onClose` を1回だけ呼ぶ。
    - スマホ：シートは下へ抜ける（`translateY(100%)`、`--duration-base`・`--ease-in`）。暗い背景の層は先に薄くなる（`opacity → 0`、`--duration-fast`・`--ease-in`）。
    - PC：`scale(.96)`＋`opacity 0`（`--duration-fast`・`--ease-in`）。
    - `useExitAnimation` の `ref` は**シート（`role="dialog"`）に付ける**（暗い背景の層の160msの `transitionend` で、シートが抜け切る前に閉じないように）。保険のタイマーは一番長い出る動き＝`--duration-base`（240ms）＋50ms。PC でも同じ値でよい（PC のシートの `transitionend` が160msで先に届く）。
    - 出る動きの途中は、シートと暗幕に `pointer-events: none` を付け、もう一度閉じる操作が届いても何もしない（`useExitAnimation` の二度押しの決まり）。
    - `prefersReducedMotion()` が true（jsdom を含む）なら即時（今と同じ）。
  - ブラウザの戻る（popstate）と Android の戻るで閉じたときは、URL が先に変わってシートが即座に消える今のまま（**即時**。「判断してほしいこと」6）。View Transitions で下へ抜く動きは付けない（戻るの反応が遅れるため）。
  - 誘い・募集の作成のあと詳細へ置き換えて移るとき（M-03）は、出入りの動きを走らせない（M-03 の「シートの差し替え」）。
  - URL を持たないシート（ここ暇の追加・くり返し・招待リンク・行きたいの作成など、`BottomSheet` を直接使うもの）も同じ動き。呼び出し側の `onClose`（状態を `null` にするなど）は、出る動きのあとで1回だけ呼ばれる。
  - フォーカスの扱い（開いたらシートへ、閉じたら開いたボタンへ。開いたボタンは最初の描画で覚える）と、本体（`#root`）の `inert` は今の順序のまま。出る動きのあいだも `inert` とフォーカスの閉じ込めは続け、`onClose` のあとのアンマウントで戻す。
  - 誘い・募集の作成の送信中に閉じたら、成功しても詳細へ移らない（T-11 の決まり）は今のまま。

#### M-02 つまみと見出しの行を引くと、シートが指についてくる（スマホだけ）
- **今**：`BottomSheet.tsx` の `onGripDown`/`onGripUp` は、離した位置が60px（`DRAG_CLOSE_PX`）以上下なら閉じ、10px（`TAP_SLOP_PX`）未満ならタップとして閉じる。引いている間シートは動かない。反応するのは幅64pxのつまみだけ。
- **振る舞い**：
  - つかめる範囲を、つまみ＋見出しの行（`sticky` の帯。タイトル・オフラインの帯を含む）に広げる。帯の中の押せるもの（`button`・`a[href]`・`[role="button"]`・`input`・`select`・`textarea`。`closest()` で起点から見る。「閉じる」・「…」など）から始めた押し込みは、引っぱりにしない（今までどおりボタン・リンクとして働く）。帯には `touch-action: none` を付ける。
  - 引いている間は、シートに `transform: translateY(移動量)` を直接当てる（transition なし）。上方向（移動量が負）は、移動量を1/3にする（ゴムのような抵抗）。暗い背景の層（M-01）の濃さは `1 - clamp(移動量 / シートの高さ, 0, 1)` にする。
  - 離したときは、下の判定の関数で決める：
    - 閉じる：M-01 の出る動きを、今の位置から続ける。
    - 戻る：`translateY(0)` へ `--duration-base`・`--ease-spring` で戻す。暗い背景も元の濃さへ。
    - タップ：**つまみ（`data-testid="sheet-grip"`）から始めたときだけ**閉じる（今のまま）。見出しの行（タイトル・アバター・バッジ・オフラインの帯）から始めたタップは何もしない（「戻る」と同じ扱い。今は見出しを触っても閉じないので、軽く触っただけで閉じることを増やさない）。
  - `pointercancel` では、閉じずに戻す。
  - PC の幅（つまみを隠している）では効かない（今と同じ）。見出しの行を引いても何もしない。
  - 中身のスクロールが一番上のときに中身から下へ引いてシートごと下げる操作は、ブラウザのスクロールとぶつかる（`touchmove` を止める作りが要る）ので、このタスクではやらない（スコープ外。指示書は「やる（後回しも可）」としていたので「判断してほしいこと」12 に並べる）。
- **判定の関数**（`apps/web/src/ui/sheetDrag.ts`。純粋な関数）：
  - `sheetDragOutcome({ origin, moved, maxMoved, velocity, height }): "tap" | "close" | "settle"`
    - `origin`：押し始めた場所（`"grip"`＝つまみ、`"header"`＝見出しの行のそれ以外）。`moved`：離した位置 − 押した位置（px。下が正）。`maxMoved`：押してから離すまでで、押した位置から一番離れた距離（px。絶対値）。`velocity`：離す直前の100msの下向きの速さ（px/ms。下が正）。`height`：シートの高さ（px）。
    - `maxMoved < 10`（`TAP_SLOP_PX`）なら、`origin` が `"grip"` のとき `"tap"`、`"header"` のとき `"settle"`。
    - それ以外で、`moved >= height * 0.3`、または `moved > 0` かつ `velocity >= 0.5` なら `"close"`。
    - それ以外は `"settle"`。
  - `sheetDragOffset(moved): number`：`moved >= 0` ならそのまま、負なら `moved / 3`。
  - 今の `DRAG_CLOSE_PX`（60px）はやめる。

#### M-16 シートの中のスクロールを後ろへ抜けさせない
- シートの `role="dialog"` の要素（`overflow-y-auto`）に `overscroll-behavior: contain` を付ける。

### 2. 実装PR②：送る・成立・結果（M-03、M-04、M-09、M-14、M-12）

#### M-14 送るボタンの「送信中」
- **今**：`apps/web/src/ui/Button.tsx` の `SendButton` は、送信中は呼び出し側が `disabled` にし、`disabled:bg-surface-sunken disabled:text-ink-disabled`（灰色）になる。押した瞬間に主ボタンの青が灰色に変わる。
- **振る舞い**：
  - `SendButton` に送信中の状態を渡せるようにする（`pending`）。送信中は：
    - 元の色のまま `opacity: .7`（`--duration-fast`）。文言は呼び出し側が渡す送信中の文言（「送っています…」など）に替える。くるくる回る印は使わない（T-11）。
    - 押せない。ただし `disabled` ではなく `aria-disabled="true"` にし、押しても・Enter でフォームを送っても何もしない（フォーカスがボタンに残り、`body` に外れない。`BottomSheet.tsx` の Esc のコメントにある「送信中に押せなくなってフォーカスがシートの外に出る」ことが起きなくなる）。
  - 灰色（`disabled:` の色）は、オフラインのとき（今のまま）と、入力がそろっていないとき（相手を選んでいない・時間が正しくない、など今の条件）だけ。送信中とオフラインで見た目が違う。
  - T-54 の `SaveButton`（`state: "saving"`）も同じ送信中の見た目にする（灰色にしない）。文言は「保存しています…」。T-54 の仕様書の「動き（アニメーション・トランジション）は付けない」には、この仕様書PRで「T-56 M-14 で変わる」と書き添えた（「✓ 保存しました」の長さ2秒と色は T-54 のまま）。`SaveButton.test.tsx` の「アニメーションのクラスがない」「送信中は押せない」の確かめは、実装PR②でこの節に合わせて直す。

#### M-03 送った手応えと、シートの差し替え
- **今**：誘いの作成（`apps/web/src/pages/InviteNewPage.tsx`）で「誘う」を押すと、送信中は灰色の押せないボタンになり、成功すると `navigate("/invites/{id}", { replace: true })` で誘いの詳細へ置き換わる。`App.tsx` の `sheetOf` では作成と詳細が別のページの部品なので、`BottomSheet` ごと作り直され、中身がすり替わり、シートの高さ（作成は `max-h-[92dvh]` いっぱい、詳細は中身の高さ）が瞬間で落ちる。募集の作成（`BroadcastNewPage.tsx`）も同じ。
- **振る舞い**：
  - 送る操作のボタンに、3つの状態を持たせる部品 `SubmitButton`（`apps/web/src/ui/SubmitButton.tsx`）を置く。状態は1つの値で渡す（`"ready" | "sending" | "done"`。`vercel-composition-patterns`）。
    - `sending`：M-14 の送信中。文言は「送っています…」（誘い）、「募っています…」（募集）、「置いています…」（行きたい）、「入れています…」（ここ暇の時間を決めて入れる）。
    - `done`：ボタンが「✓ 送りました」（誘い）／「✓ 募りました」（募集）／「✓ 置きました」（行きたい）／「✓ 入れました」（ここ暇）に変わる。見た目は T-54 の `SaveButton` の「✓ 保存しました」と同じ（`Button` の variant `saved`＝枠 `border-meet`・地 `bg-meet-soft`・文字 `text-meet-ink`、「✓」は `aria-hidden`、ボタンの外の見えない `role="status"` で読み上げる）。✓ の部分は `SaveButton` と同じ部品（`DoneLabel`）を使う。色の切り替えは `--duration-fast`。
    - `done` を見せる長さは500ms（`SENT_HOLD_MS`）。そのあと次へ進む（下）。`prefersReducedMotion()` が true（jsdom を含む）なら、`done` を見せずにすぐ次へ進む（即時）。
  - 失敗：今の静かな文言（`sendErrorText`。`text-s text-ink-muted`、`role="status"`）のまま。赤くしない。ボタンは `ready` に戻る。
  - 成功したあとの「次へ」：
    - 誘い・募集の作成：詳細へ置き換えて移る（今のまま）。送信中か `done` のあいだにシートを閉じていたら移らない（今の決まりを `done` のあとにも確かめる）。
    - 行きたいの作成（`wish/MyWishes.tsx`）・ここ暇の時間を決めて入れる（T-55 の `TimeRangeSheet`）：シートを閉じる（今のまま。M-01 の出る動きで閉じる）。
  - **シートの差し替え**（誘い・募集の作成 → 詳細）：
    - `router.ts` に `swapSheet(to)` を足す。`navigate(to, { replace: true })` と同じに移り、移る前に今のシート（`role="dialog"`）の高さ（px）を覚える。
      - 覚え方：モジュールの中の変数に `{ to, height }` を入れる。**読んでも消さない**（`main.tsx` は `StrictMode` なので、開発中は初期化と effect が2回走る。2回読んでも同じ値になるようにする）。次の `navigate`・`swapSheet`・`popstate` で上書き（`navigate` と `popstate` では空に）する。`BottomSheet` は、`to` が今の URL と同じときだけ使う。
    - 移った先の `BottomSheet` は、覚えた高さがあれば：入る動き（M-01）を走らせない。
      - シートの高さを、覚えた高さ（px）に固定して描き始める。詳細はこのあと取りに行く（作成の `onSuccess` は `invalidateQueries` だけで、詳細のキャッシュはない）ので、最初の中身は骨組み（`Loading`）になる。**読み込み中は覚えた高さのまま保つ**（骨組みの高さへは縮めない）。
      - 詳細の中身が描けたら（読み込み中が終わった最初の描画のあと。`ResizeObserver` で中身の大きさが決まったのを待つ）、中身の `scrollHeight` を測り、覚えた高さ（px）から測った高さ（px）へ、`height` の transition（`--duration-sheet`・`--ease-spring`）で縮める。**`height: auto` への transition（`interpolate-size`）は使わない**（Safari・Firefox で動かないため。0-1 の6）。終わったら（`useExitAnimation` と同じ保険のタイマー）`height` の指定を外す。中身は `opacity 0 → 1`（`--duration-fast`・`--ease-out`）で入る。
      - 測った高さが画面の上限（`max-h-[92dvh]`）を超えるときは、上限の px までにする。詳細の取得が失敗したとき（「読み込めませんでした」）も、その中身の高さへ同じに縮める。
    - `prefersReducedMotion()` が true なら、高さも中身も即時（高さを固定しない）。
    - フォーカスは今のまま（詳細のシートへ移る）。閉じると作成の前の画面に戻る（T-11）は今のまま。
  - 同じ部品を使う所：誘いの作成「誘う」、募集の作成「暇な人いる？と募る」（今の文言のまま）、行きたいの作成、ここ暇の「時間を決めて入れる」（T-55）。T-54 の `SaveButton` は保存のための別の部品のまま（✓ の部分だけを共有する）。

#### M-04 成立の瞬間（T-43 を土台にして、足りない部分だけ足す）
- **今**：
  - T-43（実装済み）が、誘いの詳細・募集の詳細・成立した予定の詳細で、成立した予定ごとに端末で1回だけ「ふたつの灯りが重なる」演出（`apps/web/src/invitations/MeetMoment.tsx`、`index.css` の `kh-meet-*`）を出す。サーバーの応答で `meetupId` が入ってから流し、楽観的更新の間は流さない。誘った側にも、成立を知って最初に開いた1回だけ流す。「見た」は端末の `kokohima.meetMomentSeen`。
  - 受信者が「行く」を押すと、楽観的更新（`InviteDetailPage.tsx` の `optimisticStatus`）で状態が `confirmed` になり、返答のボタン群（`ResponseButtons`）は一瞬で消え、バッジ（`Badge`）は「返事をしてください」から緑の「成立」に瞬間で替わる。
  - 「成立した予定を見る」は、誘いの詳細（`InviteDetailPage.tsx`）と募集の詳細（`BroadcastDetailPage.tsx`）で、本文と同じ大きさの下線の文字リンク（`text-action underline`）。
- **T-43 と指示書の案の違いと、どちらを残すか**（「判断してほしいこと」2・8）：

  | 点 | T-43（実装済み） | 指示書の案（M-04） | この仕様書 |
  | --- | --- | --- | --- |
  | 演出の中身 | 灯りの色の丸（表示名の1文字め）が寄って重なり、青緑に変わる。`meet-soft` の背景、「決まった！」・日時・エリア・「〇〇と会える」・.ics が下から順に出る | `meet-soft` の帯が上端から広がり、2人のアバターが寄って重なる。「成立しました」の大きな文字 | **T-43 を正とする**（二重に作らない） |
  | 長さ | 丸1.2秒＋文字0.95〜1.5秒 | 600〜800ms（全部で1秒以内） | T-43 のまま |
  | 黄色 | 丸の最初の色が灯り（`lamp`）で、重なって青緑に変わる | 黄色は使わない | T-43 のまま（0-1 の決まり2の例外として明記） |
  | 誘った側 | 成立を知って最初に開いた1回だけ流す | 同じく1回だけ | 同じ（T-43 のまま） |
  | 「見た」の持ち方 | 端末の localStorage に予定の ID（50件まで。ログアウト・退会で消す） | 端末の保存でもよい（CLAUDE.md に照らして確認） | T-43 のまま（トークンではなく予定の ID だけで、T-43 のレビューで CLAUDE.md と照らした） |
  | 3人以上 | 自分を左に4つまで、5人以上は「+n」 | 書いていない | T-43 のまま |
  | 一覧での演出 | しない（T-43 のスコープ外） | 一覧で初めて成立を見たときも1回 | T-43 のまま（しない） |
  | いつ流すか | サーバーの応答で `meetupId` が入ってから | 成功を待たずに出し、失敗したら静かに戻す | 演出（丸）は T-43 のまま応答を待つ。下の「足す部分」のボタン群の退場とバッジの「ぽん」は、楽観的更新のときに出し、失敗したら静かに戻す |
  | 動きを止める設定 | 重なった青緑の丸と文字の一枚絵 | 帯とボタンだけが静かに出る | T-43 のまま（足す部分も即時） |

- **足す部分**（演出の強さは「中」。「判断してほしいこと」2）：
  1. **ボタン群の退場**：誘いの詳細の返答のボタン群（「行く」「今回は難しい」「この時間なら」と下の注記・「この時間なら」のフォーム）と、送信者の「決める」「見送る」のボタン群を `Collapse` で包む。押して楽観的更新で状態が変わったら、縮んで消える（`Collapse` の閉じる動き＝高さと `opacity`、`--duration-fast`・`--ease-in`。中身は `scale(.96)` も足す）。
     - 「今回は難しい」・「見送る」で消えるときも、同じ静かな動き（赤・揺れ・✕を使わない。決まり1）。
     - 送れなかったとき（楽観的更新を戻したとき）は、ボタン群が元の場所に `Collapse` の開く動きで戻り、今の静かな文言（「送れませんでした。もう一度お試しください」）が出る。T-43 の演出は応答を待つので、もともと流れていない（巻き戻す演出はない）。
  2. **バッジの「ぽん」**：**自分の操作**（「行く」・「決める」の楽観的更新、またはその操作の成功の応答）でバッジが `meet` に変わったときと、T-43 の演出が流れる最初の描画のときに、1回だけ `scale(.6) → scale(1.08) → scale(1)`（`--duration-sheet`・`--ease-spring`。キーフレーム `kh-badge-pop`）。
     - 判定は `Badge` の `tone` の変化ではなく、詳細の画面が自分の操作の mutation（`onMutate`・`onSuccess`）で立てる印で決める。詳細を開いている間に、取り直し（ウィンドウに戻ったときの `refetch` など）で相手の操作により `meet` に変わったときは、ぽんしない（自分の操作ではないため。T-43 の演出が流れる条件に当たれば、そちらで流れる）。
     - `meet` 以外への変化（断り・見送り・期限切れ・締め切り・やっぱり難しい）では動かさない（決まり1）。送れなかったときに元のバッジに戻るのも動かさない。
     - 一覧のカード（`InviteCard`）のバッジでは動かさない（T-43 と同じく一覧での演出はしない）。
     - 対象の画面：誘いの詳細・募集の詳細（予定の参加者だけ）・成立した予定の詳細（T-43 の演出が流れるときだけ）。
  3. **「予定を見る」を `meet` の塗りのボタンにする**：誘いの詳細と募集の詳細の「成立した予定を見る」を、文字リンクから `ButtonLink`（`block`）に替え、`Button` に variant `meet`（`border-transparent bg-meet text-on-meet`）を足して使う。文言は今のまま「成立した予定を見る」（T-43 で「1つだけ・今の場所」と決めたので、場所と数は変えない）。
- **変えないこと**：T-43 の演出の中身・長さ・色・並べ方・流す条件・「見た」の記録。音・振動（M-20）。紙吹雪・全画面の祝い。

#### M-09 操作の結果は「結果の帯」に出す
- **今**：
  - 共通の `Toast`（`apps/web/src/ui/feedback.tsx`）は本文の流れの中に置かれる一文で、出た瞬間に下の中身が押し下げられる。出入りの動きも、自動で消える仕組みもない。使っているのは、お知らせの「見せないにしました」（`NotificationsPage.tsx` の `HideFromFriend`）と、カレンダー連携の結果（`CalendarSettingsPage.tsx`）の2か所。
  - ここ暇の追加（main の `AvailabilityPage.tsx` の「追加しました」）は、シートの一番下の `text-s text-ink-muted` の一文。2回目も同じ文のまま。**T-55 がここ暇タブを週の帯に作り直し、この一文はなくなる**。T-55 は代わりに、下のタブの上に数秒出す一文と「取り消す」（`apps/web/src/ui/UndoToast.tsx`、6秒、`kh-rise` で下から出る）と、押したマスの「ぽん」（`kh-pop`）を足している（作業中のブランチ `feat/T-55-availability-week-grid`）。
  - 今ひま（T-40、`availability/FreeNowCard.tsx`）は、やめたあとに灯りのボタンの場所を、灰色の「今ひまをやめました」と「元に戻す」（5秒）に置き換える。
- **振る舞い**：
  - 画面に1つだけの「結果の帯」を置く。部品は T-55 の `UndoToast` を正とし、アプリ全体で1つにする（`ResultBandProvider` を `App` に置き、`useResultBand().show({ text, undo? })` で出す。T-55 の `WeekPlanner` もこれを使うように直す）。
    - context に渡すのは、変わらない `show` の関数だけにする。今出している帯の文言・タイマーなどの状態は `ResultBand` の部品の中だけで持ち（`show` は `ResultBand` の中の更新を呼ぶ）、帯を出すたびに `useResultBand` を使う画面が描き直されないようにする（`vercel-react-best-practices` の rerender の決まり）。
    - 位置：T-55 のとおり、下のタブの上（スマホ）・左のナビの右（PC）。シートを開いているときはシートの上に重ねる（重なりの順をシートより上にする）。中身を押し下げない（`position: fixed`）。
    - 読み上げ：`role="status"` の場所はいつも置いておき、中身だけを入れ替える（T-55 のまま）。
    - 入る：`translateY(8px)`＋`opacity 0` → `0`・`1`（`--duration-base`・`--ease-out`）。出る：`opacity → 0`（`--duration-fast`・`--ease-in`）。T-55 の `kh-rise .2s ease-out` を、このトークンに置き換える。
    - 消えるまで：「取り消す」があるものは T-55 の6秒（`UNDO_TOAST_MS`）、文だけのものは3.5秒。指やマウスを乗せている間・フォーカスがある間は消さない（T-55 のまま）。
    - 新しい結果が来たら、今の帯を差し替えて入る動きからもう一度出す（同じ文でも、もう一度出たことが分かる）。
    - 色は今の `Toast` と同じ静かな色（`bg-ink`・`text-surface`・`shadow-float`）。成功も失敗も同じ見た目（赤を使わない）。
  - 結果の帯に移すもの：お知らせの「見せないにしました」（ボタンは `Collapse` で消し、帯に出す）、カレンダー連携の結果（`?result=` の文）。`feedback.tsx` の `Toast` は使う所がなくなるので消す。
  - 押したボタンそのものの ✓（指示書の「プリセットのボタンが一瞬 ✓ に変わる」）：T-55 でここ暇のプリセットのボタン（昼・夕方・夜）はマスになり、押したマスが「ぽん」と灯る（T-55 の `kh-pop`）ので、このタスクでは ✓ を足さない。`kh-pop` の長さと曲線を、`--duration-sheet`・`--ease-spring` にそろえる。送る操作のボタンの ✓ は M-03。
  - 今ひま（T-40）の「元に戻す」は、灯りのボタンの場所を置き換える作り（結果の帯ではない）のまま。動きだけそろえる：灰色の帯は入る動き（`opacity`＋`translateY(8px)`、`--duration-base`・`--ease-out`）で出て、5秒で消えて灯りのボタンに戻るときは `--duration-fast` のフェード。長さ（5秒）と文言は T-40 のまま。
  - 安全の操作（`safety/PersonActions.tsx`）と問い合わせ（`ContactPage.tsx`）は「Toast を使わない」と仕様で決めているので、結果の帯も使わない（今のまま）。
  - T-54 の保存のボタンの「✓ 保存しました」は今のまま（結果の帯を使わない）。

#### M-12 「重なっています」の灯りが、一回だけともる
- **今**：`apps/web/src/ui/AvailabilityChip.tsx` は、重なる枠（`overlaps`）を `bg-lamp shadow-lamp` で、描いた瞬間から光らせる。
- **振る舞い**：
  - 重なる枠が初めて画面に入ったとき（`IntersectionObserver`。半分以上見えたとき）、`lamp-soft` の地・影なしの状態から、`lamp` の地・`shadow-lamp` へ、影が広がりながら灯る（500ms、`--ease-out`。キーフレーム `kh-lamp-on`）。一回だけで、ずっと明滅させない。
  - 一回だけの判定：灯した枠の印（枠の ID ＋開始時刻）をメモリの `Set` に持ち、同じ枠はスクロールで出入りしても、ほかのタブから戻っても、もう一度灯さない（アプリを開き直したら、また一回灯る）。
  - `prefersReducedMotion()` が true（jsdom を含む）・`IntersectionObserver` がない環境では、最初から灯った状態（今の見た目）。
  - 決まり3：重ならない枠・見えなくなった枠には動きを付けない。灯るのは「自分と重なる」と分かった枠だけで、相手ごとに違う動きはしない。

### 3. 実装PR③：一覧とナビ（M-05、M-06、M-07、M-08、M-10、M-11、M-13、M-15、M-17〜M-19、見た目の崩れ V-1・V-2）

#### M-05 起動したときから、アプリの殻を出す
- **今**：`apps/web/src/App.tsx` で、ログインの確認中（`status === "checking"`）は `PageLoading`（`main` の中に `Loading` が1つ）だけを描く。ヘッダーも下のタブもなく、確認が終わった瞬間に全部が出る。
- **振る舞い**：
  - 確認中で、URL がタブ（`/`・`/availability`・`/invites`・`/friends`。`TAB_PATHS`）か、後ろにタブを出すシートの URL（`sheetOf` の表）のときは、そのタブの殻（`TabScreen` と同じ位置のヘッダーと下のタブ。PC では左のナビ）を描き、中身だけを骨組み（M-06）にする。シートは描かない（確認が終わってから描く）。
    - ヘッダーの名前は、そのタブの名前（`TABS` の `label`）。
    - 鐘は、同じ大きさの押せない印（未読の数なし）にする。**お知らせの未読の数は読みに行かない**（ログインの前に API を叩かない）。PC の左のナビの「お知らせ」「設定」も、未読の数なしで描く。
    - 下のタブ（左のナビ）は描くが、確認が終わるまで `inert` にする（押しても動かない。見た目は今のタブと同じ）。今いるタブの印（M-07）は付ける。
    - 部品：`TabScreen` に真偽の引数を足さず、殻だけの部品（`TabShell`。ヘッダーと下のタブの置き方を `TabScreen` と共有する）を分けて作る（`vercel-composition-patterns`）。
  - それ以外の URL（設定・お知らせ・ログイン・招待の受け口など）の確認中は、今のまま `PageLoading`。
  - 確認中と確認後で、ヘッダーと下のタブの位置が1pxも動かない（同じ部品の同じ置き方で描く）。jsdom には配置がないので、これは E2E の `boundingBox()` で確かめる（テスト計画）。
  - ログインしていない人にも、確認が終わるまで殻を見せてよい（**見せてよい**。確認は通常すぐ終わる。「判断してほしいこと」7）。確認の結果が `anonymous` ならログイン画面へ移る（今のまま）。表示名がない人は、確認のあと名前の画面（T-31）に替わる（今のまま）。
  - 殻に出すのはタブの名前だけで、個人の情報・未読の数・友達の情報は出さない。

#### M-06 読み込み中の骨組み
- **今**：`feedback.tsx` の `Loading` は、灰色の棒3本のカード1枚で、動かない。どの画面でも同じ形。
- **振る舞い**：
  - 明滅：`opacity 1 ↔ .55` を1.4秒で繰り返す（キーフレーム `kh-breathe`、`ease-in-out`）。光が流れる動きは使わない。動きを止める設定では止まる（CSS の共通の指定）。
  - 形：`Loading` に `variant` を足す。`card`（今の形。既定）、`list`（丸＋2行の棒を3行）、`chips`（日付の帯＋丸いチップの棒を2行）。数は件数によらず固定（決まり3）。
    - `list`：友達一覧・お知らせ・ブロックした人・友達の詳細の行きたい。
    - `chips`：みんなタブのここ暇、ここ暇タブ（T-55 の週の帯の画面の読み込み中に合わせる）。
    - `card`：誘いタブの各一覧・誘いと募集の詳細・成立した予定の詳細・そのほか。
  - 200ms 未満で読み終わるときは骨組みを見せない：骨組みは、200msの遅れ（`animation-delay`）のあとに `--duration-fast` で出る（CSS だけ。タイマーを使わない）。`role="status"` と `aria-label="読み込み中"` は最初の描画から置く（テストと読み上げのため）。
    - 書き方（0-1 の4）：骨組みの普段の指定は `opacity: 1`（見える形）のまま。出る動きはキーフレーム `kh-fade-in`（`from { opacity: 0 }` だけを書く）を `animation: kh-fade-in var(--duration-fast) var(--ease-out) 200ms backwards` で付け、遅れの200msの間も `from` の透明を保つ。
    - 明滅（`kh-breathe`）は、同じ要素に2つめの動きとして並べる（`animation: kh-fade-in …, kh-breathe 1.4s ease-in-out calc(200ms + var(--duration-fast)) infinite`）。`kh-breathe` は `opacity: 1 → .55 → 1` で、出終わってから始まる。
    - 動きを止める設定では、共通の指定（`animation: none`）で両方が外れ、骨組みは**すぐに・明滅せずに**見える（200msの待ちもしない）。
  - 中身への置き換え：読み込み中のあと最初に描く中身を `FadeIn`（描いたときに `opacity 0 → 1`、`--duration-fast`・`--ease-out`）で包む。取り直し（`refetch`）では動かさない。
  - `role="status"`・`aria-label="読み込み中"` は今のまま（テストが頼っている）。

#### M-07 下のタブ：今いる場所・もう一度押す・スクロールの位置
- **今**：`apps/web/src/ui/Navigation.tsx` の `NavLink`。今いるタブは文字が `text-ink` になり、下に直径4pxの `bg-lamp-line`（黄色）の点が出るだけ。アイコンは同じ線画。PC の左のナビの今いる場所は `bg-lamp-soft`（T-20）。今いるタブをもう一度押しても何も起きない。`Link`・`navigate` はスクロールを扱っていないので、前のタブのスクロールの位置のまま次のタブが開く。
- **振る舞い**：
  - 今いるタブのアイコンを塗りの版に替える（4つのタブの塗りのアイコンを足す）。点はやめ、アイコンの下の短い線（幅16px・高さ2px・`bg-ink`・角丸 `rounded-full`）にする。黄色はタブに使わない（決まり2）。
  - PC の左のナビの今いる場所は、`bg-lamp-soft` をやめて `bg-head`＋塗りのアイコン＋`text-ink` にする（マウスを乗せたときの `bg-surface-sunken` と見分けられる）。T-20 の記述も直す（「判断してほしいこと」10）。
  - 押したら、アイコンが `scale(.88)`（`--duration-press`）→ `scale(1)`（`--duration-base`・`--ease-spring`）。
  - 今いるタブを押したら、一番上までスクロールする（`window.scrollTo({ top: 0, behavior: "smooth" })`。動きを止める設定では `behavior: "auto"`）。URL は変えない（`?tab=` も変えない）。
  - タブを移るときは、移る先のタブで最後に見ていた位置へ（初めてなら一番上へ）。
    - 位置はタブの URL（`pathname`。誘いタブは `?tab=` によらず1つ）ごとにメモリの `Map` に持つ（localStorage・sessionStorage に置かない）。ブラウザの戻る・進むでタブを移ったときも同じ。
    - `history.scrollRestoration = "manual"` にするので、ブラウザの復元はアプリ全体で止まる。そのため、タブ以外の画面への戻る・進む（`popstate`）も自分で戻す：`router.ts` の履歴の印（`HistoryState`）に、エントリごとの印（`key`。`navigate` で積むときに作る。置き換えるときは引き継がない）を足し、画面を離れるときにそのエントリの位置を同じメモリの `Map`（`key` ごと）に覚え、`popstate` で移った先のエントリの位置へ戻す。たとえば友達タブを下までスクロールして設定を開き、戻ると、友達タブの元の位置に戻る（今のブラウザの振る舞いと同じ）。設定 → その下の画面 → 戻るも同じ。
      - 戻す位置の優先：`popstate` で戻った先に `key` の位置があればそれ、なければ（タブなら）タブの位置、どちらもなければ一番上。`navigate` で積んで進むときは、タブならタブの位置、それ以外は一番上（今と同じ）。
      - 再読み込み（`key` の位置はメモリなので消える）と、外から直接開いたときは、一番上から（今はブラウザが再読み込みで位置を戻すが、これは戻らなくなる。メモリだけに持つ決まりを優先する）。
    - タブからシートを開いて閉じたときは、後ろのタブを描き直さないので、位置は今のまま。
    - 純粋な関数（`apps/web/src/ui/tabScroll.ts`）：`rememberTabScroll(positions, from, y)`・`tabScrollTarget(positions, to)`（初めてなら0）。エントリごとの位置は `scrollTargetOnPop(entryPositions, tabPositions, to)`（上の優先の順）。
  - 中身の切り替え（タブ ↔ タブ）は、View Transitions で `--duration-fast` のクロスフェード（左右に滑らせない）。
  - `aria-current="page"` は今のまま。

#### M-08 誘いタブの切り替えの白い板を滑らせる
- **今**：`apps/web/src/pages/InvitesPage.tsx` の「受信・送信・募集・成立」の切り替えは、今の項目のリンクにだけ `bg-surface shadow-card` を付けるので、白い板が瞬間で移り、中身も瞬間で替わる。
- **振る舞い**：
  - 白い板を、リンクとは別の1枚の要素（`aria-hidden`）にし、`transform: translateX(項目の幅 × 番号)`（幅は4分の1。`translateX(100% × 番号)`）で滑らせる（`--duration-base`・`--ease-out`）。最初の描画では動かさない。
  - 中身は `FadeIn`（M-06）でクロスフェード（`--duration-fast`）。
  - 左右のスワイプでの切り替えはしない（**しない**。「判断してほしいこと」3）。
  - URL（`?tab=`）と `aria-current` の振る舞いは今のまま。

#### M-10 自分の操作で増える・消える行
- **今**：ここ暇の「取り消す」（main の `AvailabilityPage.tsx` の `MyAvailabilities`。楽観的更新）は行が一瞬で消え、下の行がガタッと上がる。シートで追加したものも、後ろの一覧に瞬間で差し込まれる。行きたい・招待リンク・ブロックした人の一覧も同じ。T-55 では、ここ暇は週の帯のマスになり、マスの中の複数のここ暇はシート（`CellSheet`）の行、くり返しは一覧の行になる。
- **振る舞い**：
  - 対象は、**自分の操作で増減した行だけ**：
    - 消える：ここ暇のマスのシートの行（T-55 の `CellSheet` の「取り消す」「この日だけ外す」）、くり返しの行の削除、自分の行きたいの削除、招待リンクの「無効にする」、ブロックした人の「解除」。
    - 増える：くり返しの追加、行きたいの作成、招待リンクの発行。
  - 消える：行を `Collapse` で閉じる（`opacity → 0` と高さを0へ。`--duration-fast`・`--ease-in`）。閉じ終わってから描かない。下の行は高さの変化で滑って詰まる。
  - 増える：行を `Collapse` で開く（`--duration-base`・`--ease-out`）。シートを閉じたあとに見えるよう、シートの出る動き（M-01）が終わってから開き、開いたあとに一度だけ地を `surface-sunken` から元の色へ戻す（ふわっと光る。600ms。黄色は使わない＝決まり2）。
    - どの行が「自分が増やした行」かは、作成の応答の ID をメモリに持って決める（一度光ったら消す）。
  - 楽観的更新が失敗して戻ったとき：消した行が、元の場所に `Collapse` で開いて戻る。
  - 取り消しに「元に戻す」は足さない（**動きだけ**。「判断してほしいこと」4）。T-55 のここ暇のマスの「取り消す」（結果の帯）と、T-40 の今ひまの「元に戻す」は、それぞれの仕様のまま。
  - 決まり3：友達の側のデータ（みんなタブのここ暇、友達の詳細の行きたい、誘い・募集の一覧）の行の出入りには動きを付けない。友達のここ暇が見えなくなったときも、特別な退場の動きを付けない。
  - 動きを止める設定では即時。

#### M-11 押したときの感触
- **今**：押した反応があるのは `Button` の `active:scale-[.98]` と、今ひまのボタンだけ。誘い・募集のカード（`ui/InviteCard.tsx`）、設定の行（`SettingsPage.tsx`）、友達一覧の行（`FriendsPage.tsx`）、お知らせの行、「誰を誘う？」の顔（`EveryonePage.tsx`。T-34）は、押しても変わらない。`-webkit-tap-highlight-color` の指定がない。カードと行に hover の変化がない。
- **振る舞い**：
  - 行（設定の一覧、友達一覧、お知らせ、ブロックした人）：押している間 `bg-surface-sunken`（`--duration-press`）。PC（`lg:`）はマウスを乗せたときも `bg-surface-sunken`。
  - カード（`InviteCard`・`BroadcastCard`）：押している間 `scale(.98)`＋影を一段弱く（`shadow-card` → 影なし）。`--duration-press`。PC はマウスを乗せたときに影を `shadow-float` に。静かな状態（`quiet`）のカードは、影を足さない。
  - 顔（「誰を誘う？」のアバター）：押している間 `scale(.95)`。
  - 全体：`index.css` の `@layer base` で、`-webkit-tap-highlight-color: transparent`。
  - フォーカスの輪（T-46。`outline`）は、押した感触のクラスで消さない（`transition` に `outline` を含めない・`outline` を書き換えない）。
  - T-11 で「スコープ外」にしていた「誘い・募集のカードを押したときの動き」は、この節で取り込む（T-11 の記述も直す）。

#### M-13 「戻る」がある画面への移動の向き
- **今**：友達タブ → 設定 → カレンダー連携などの `SubScreen`（`ui/Navigation.tsx`）は、進むも戻るも瞬間で替わる。
- **振る舞い**：
  - View Transitions で、進む＝新しい画面が右から30%ずれた位置からフェードで入り、前の画面は左へ少しずれてフェードで抜ける（`--duration-base`・`--ease-out`）。戻る＝逆（`--duration-fast`・`--ease-in`）。
  - 向きの決め方：`router.ts` の履歴の印（`HistoryState`）に深さ（`depth`）を足す。`navigate` で積むときは今の深さ＋1、置き換えるときは今の深さのまま、外から直接開いたとき（印がない）は0。`popstate` では、移った先の深さと直前の深さを比べ、小さければ戻る、大きければ進む。**ブラウザの戻る（popstate）でも向きが正しい**。
  - 動きの種類を決める純粋な関数（`apps/web/src/router.ts` の `transitionKind(from, to, direction)`）：
    - どちらかがシートの URL（`sheetOf` の表）なら `"none"`（シートは M-01 の動き。popstate で閉じたときも即時）。
    - `popstate` で、`PopStateEvent.hasUAVisualTransition` が true なら `"none"`（iOS Safari の端からのスワイプで戻る・Chrome Android の戻るの操作は、ブラウザが自分で戻る動きを見せてから `popstate` を出すので、続けて動かすと二重になる）。`navigate` が自分で出す合成の `popstate` はこれが false なので影響しない。関数には `hasUAVisualTransition` を引数で渡す（`transitionKind(from, to, direction, uaTransition)`）。
    - 両方がタブなら `"fade"`（M-07）。
    - それ以外（タブ ↔ 設定・お知らせ、設定 ↔ 設定の下）は、向きで `"push"`／`"pop"`。
  - 動かすのは中身の領域だけ：下のタブ（`TabBar`）と PC の左のナビ（T-20。`SubScreen` でも出る）に `view-transition-name`（`kh-tabbar`・`kh-sidenav`）を付け、その group の動きを `animation: none` にして動かさない。画面全体（`::view-transition-group(root)`）にも `animation: none` を当て、中身の領域（`main`）に `view-transition-name: kh-content` を付けて、push・pop・fade の動きは `::view-transition-old(kh-content)`・`::view-transition-new(kh-content)` にだけ当てる。M-07 のタブどうしのクロスフェードも同じ。
  - 対応しない端末・動きを止める設定では即時。
  - フォーカスは今のまま。スクロールの位置は M-07（`history.scrollRestoration = "manual"` にして、タブはタブごと、それ以外は履歴のエントリごとに自分で戻す）。

#### M-15 未読のバッジ
- `Navigation.tsx` の `UnreadBadge`：出るとき・数が増えたときに `kh-badge-pop`（M-04 と同じ。`scale(.6) → 1.08 → 1`、`--duration-sheet`・`--ease-spring`）。最初の描画（画面を開いたとき）では動かさない。数が減ったときは動かさない。
- 消えるとき（0になったとき）は `scale → .6`＋`opacity → 0`（`--duration-fast`・`--ease-in`。`useExitAnimation`）。
- 読み上げ（鐘のボタンの `aria-label`）は今のまま。

#### M-17 みんなタブの日付の帯を、上に貼り付ける
- `EveryonePage.tsx` の日付の見出し（`bg-head` の帯、日ごとの `section` の中の `h2`）に `position: sticky; top: 0` を付ける。日ごとに `section` が分かれているので、次の日の帯が来たら押し上げる。重なりの順はシート・下のタブより下。
- タブの画面のヘッダー（`TabScreen` の `header`）はスクロールで流れる今のまま。

#### M-18 スイッチ
- `ui/Switch.tsx`：つまみの移動（`after:transition-transform`）を `--duration-fast`・`--ease-spring`、地の色（`transition-colors`）を `--duration-fast` にする。
- 押している間（`peer-active`）、つまみを横に4px伸ばす（オンのときは左へ伸ばし、右の端の位置を変えない）。押せないときは伸ばさない。

#### M-19 空の状態
- `feedback.tsx` の `EmptyState`：出るときに下から8pxのフェードで入る（`--duration-base`・`--ease-out`）。絵を画面ごとに変えることは、別のタスク（スコープ外）。

#### M-20 振動
- 振動（`navigator.vibrate`）はしない（**しない**。「判断してほしいこと」5）。iPhone の Safari では使えず、端末で体験が割れるため。

#### V-1 誘いの詳細のヘッダーで、名前が数文字で切れる
- **今**：`InviteDetailPage.tsx` のシートの見出しは、アバター・名前と種類（`truncate`）・バッジ（`shrink-0`）・「…」（受信だけ）が1行に並び、その右に `BottomSheet` の「閉じる」が付く。受信の誘いではバッジ「返事をしてください」が長く、名前とひとことが数文字で切れる。`BroadcastDetailPage.tsx`（受け取った募集）も、見出しの名前・バッジ・「…」が同じ並び。
- **振る舞い**：バッジを名前の下の行（種類の文字「あそぼ」「ここどう？」などの横。募集では「暇な人いる？」の横）に回し、1行めは「アバター・名前・（…）」だけにする。名前の `truncate` は今のまま（それでも長い名前は切れる）。
- 動きではないが、同じ流れ（実装PR③）で直す（「判断してほしいこと」9）。

#### V-2 オフラインの帯が出るとき、中身全体がガタッと下がる
- **今**：`feedback.tsx` の `OfflineBanner` は、オフラインになった瞬間に描かれ、下の中身が帯の高さだけ瞬間で下がる。
- **振る舞い**：`OfflineBanner` を `Collapse` で包み、出るとき・消えるときに高さを開閉する（`Collapse` の長さ）。タブの画面・戻るのある画面・シートの見出しの帯の、3か所とも。
- 実装PR③で直す（「判断してほしいこと」9）。

### 4. 置き場所
- `apps/web/src/index.css`：動きのトークン、`kh-badge-pop`・`kh-lamp-on`・`kh-breathe`・`kh-fade-in` のキーフレーム、シートの出入りの指定、`-webkit-tap-highlight-color`。
- `apps/web/src/ui/motion.ts`：`MOTION_MS`、`prefersReducedMotion`、`useExitAnimation`（`start`・`cancel`）。
- `apps/web/src/ui/Collapse.tsx`、`apps/web/src/ui/FadeIn.tsx`。
- `apps/web/src/ui/sheetDrag.ts`：M-02 の判定の関数。
- `apps/web/src/ui/SubmitButton.tsx`（M-03）、`apps/web/src/ui/SaveButton.tsx`（✓ の部分 `DoneLabel` を分ける）、`apps/web/src/ui/Button.tsx`（`SendButton` の送信中、variant `meet`）。
- `apps/web/src/ui/ResultBand.tsx`（T-55 の `UndoToast` を移して、アプリに1つにする）。
- `apps/web/src/ui/tabScroll.ts`、`apps/web/src/router.ts`（`depth`、`swapSheet`、`transitionKind`、View Transitions）。

## 認可と秘匿
- 閲覧者IDの使い方：変えない（API を変えない）。
- 他人のデータに届かないことの保証：新しい経路はない。端末に新しく保存するものはない（タブのスクロールの位置・灯した枠・増やした行の印はメモリだけで、閉じれば消える）。
- 区別させない応答（見せない／暇がない／募集の応答者など）：0-1 の決まり3のとおり、動きでも区別させない。
  - 友達のここ暇・行きたいの行の出入り、見えなくなったことに動きを付けない（M-10）。
  - 骨組みの数と形は件数・相手によらず固定。200msの遅れはすべての読み込みで同じ（M-06）。
  - 重なる枠の灯り（M-12）は、自分と重なると分かった枠すべてに同じ動き。重ならない枠・見えない枠には何も付けない。
  - 募集の人数・応答者の有無・「締め切りました」に新しい動きを付けない。成立の動き（バッジの「ぽん」・予定を見るボタン）は、T-43 と同じく予定の参加者（`meetupId` を受け取った人）にだけ出る。
  - 確認中の殻（M-05）は、タブの名前だけを出し、未読の数・個人の情報を読まない・出さない。
- ログに出すものはない（動きは画面の中だけ）。

## テスト計画

### 単体テスト（実装PRで必須）

#### 実装PR①：土台とシート
- [ ] 動きのトークン：`index.css` の `--duration-*`・`--ease-*` と `MOTION_MS` の値が一致する。出る動きのトークンが入る動きの1段下（7割前後）になっている（`apps/web/src/ui/motion.test.ts`）
- [ ] `prefersReducedMotion`：`matchMedia` がないと true、`matches` で true・false を返す
- [ ] `matchMedia` を差し替えている既存のテスト（`navigation.test.tsx` の `stubMatchMedia`、`contact.test.tsx`、`install.test.tsx` の `stubMatchMedia`）を、`(prefers-reduced-motion: reduce)` には `matches: true` を返すように直す（0-3）。とくに navigation.test.tsx の PC の配置の `BottomSheet` のテスト（「PC の配置では、つまみを隠し（lg:hidden）、右上の『閉じる』で閉じる」など、閉じた直後に `onClose` を確かめるもの）が、直したあとも今のまま通る
- [ ] `SettingsPage`：新しい端末のログインから開いたときの `scrollIntoView` が `prefersReducedMotion()` で決まる（`matchMedia` がないと `behavior: "auto"`）
- [ ] `useExitAnimation`（`vi.useFakeTimers()`）：動きを止める設定（`matchMedia` の `matches: true`）では `start` の中で即時に `done` を1回呼ぶ。止めない設定では、長さ＋50msまでは呼ばず、＋50msで1回だけ呼ぶ。要素自身の `transitionend` が先に来たらそこで1回だけ呼び、タイマーでは呼ばない。子から泡立った `transitionend` では呼ばない。途中で `start` をもう一度呼んでも1回だけ。途中でアンマウントしたら呼ばない。`done` のあと `exiting` が false に戻り、もう一度 `start` すると、また1回だけ `done` を呼ぶ（閉じて開いてもう一度閉じる）。途中で `cancel()` すると `done` は呼ばれず（タイマーが過ぎても）、`exiting` が false に戻る
- [ ] `Collapse`：閉じる途中で `show` が true に戻ると、中身が残り（保険のタイマーが過ぎても消えない）、開いた見た目に戻る。閉じて・開いて・もう一度閉じても、閉じ終わると中身が消える
- [ ] `BottomSheet`（`apps/web/src/ui/navigation.test.tsx` に足す）：止めない設定で「閉じる」・暗幕・Esc・つまみのどれでも、すぐには `onClose` を呼ばず、出る動きの印（`data-exiting`）が付き、保険のタイマー（240＋50ms）のあとに1回だけ呼ぶ。暗い背景の層（`sheet-backdrop`）の `transitionend` が先に来ても、`onClose` は呼ばない（`ref` はシート）。**閉じる動きの途中でもう一度「閉じる」・Esc・暗幕を押しても `onClose`（`goBack`）は1回だけ**。動きを止める設定では即時（既存のテストのまま通る）
- [ ] `BottomSheet`：暗い背景は暗幕の要素とは別の層で、シートはその層の子ではない（暗い背景の `opacity` でシートが薄くならない）
- [ ] `BottomSheet`：出る動きの途中もフォーカスがシートの外に出ず、`onClose` のあと開いたボタンにフォーカスが戻る（既存のテストのまま）
- [ ] `BottomSheet`：PC の幅では、入る・出る動きのクラスが下からではなく縮みとフェードの側になる
- [ ] `sheetDragOutcome`（`apps/web/src/ui/sheetDrag.test.ts`）：つまみから始めて `maxMoved` 9px は tap、10px は tap でない。見出しの行から始めて `maxMoved` 9px は settle（tap にならない）。高さ600pxで `moved` 179px・速さ0.4は settle、180px は close。`moved` 30px・速さ0.5は close、0.49は settle。上へ引いて（`moved` 負）速さが大きくても close にしない
- [ ] `sheetDragOffset`：下はそのまま、上は1/3
- [ ] つまみと見出しの行：引いている間 `transform` が付き、離すと判定どおりに閉じる・戻る。「閉じる」のボタン・リンク（`a[href]`）・`[role="button"]` から始めた押し込みは引っぱりにならない。**シートのタイトル（見出しの文字）を押して離しても閉じない**（つまみを押して離すと閉じる）。`pointercancel` では閉じない。PC の幅では効かない
- [ ] シートに `overscroll-behavior: contain` が付いている（M-16）
- [ ] 色の直書きがない（`colors.test.ts` のまま）。動きの長さと曲線の直書きがない検査を足す（`apps/web/src` の `.tsx`・`.ts` と `index.css`）：クラスの `duration-[0-9]`・`duration-\[`・`ease-\[`・`animate-\[`・`delay-\[`、Tailwind の既定の `transition`・`transition-*` で長さを付けていないもの、CSS の `[0-9.]+m?s` の秒・ミリ秒の数（`@theme` の `--duration-*` の定義と、`kh-breathe` の 1.4s、T-43 の `.kh-meet-dot`・`.kh-meet-pair`・`.kh-meet-reveal` と `kh-meet-*` のキーフレームだけを除く。0-1 の5）
- [ ] `Button` と今ひまのボタンの `transition-transform` が `--duration-press` で書かれている
- 他人のIDでは取得・更新できない：API を変えないので対象外

#### 実装PR②：送る・成立・結果
- [ ] `SendButton`（M-14）：送信中は `aria-disabled="true"` で、`disabled` ではなく、`disabled:` の灰色にならず `opacity` が下がる。送信中に押してもフォームを送っても何も起きない。オフラインでは `disabled` の灰色。送信中とオフラインでクラスが違う
- [ ] `SubmitButton`（M-03。フェイクタイマー）：`ready`→`sending`（「送っています…」）→`done`（「✓ 送りました」、variant `saved`、「✓」は `aria-hidden`、status が「送りました」）。止めない設定では500msまで `done` を見せてから次へ進み、動きを止める設定では即時に次へ進む。失敗は静かな文言で、ボタンは `ready` に戻る
- [ ] 誘いの作成（`apps/web/src/pages/invites.test.tsx`）：送ると「送っています…」のあと詳細へ置き換わる。`done` のあいだにシートを閉じたら詳細へ移らない。募集の作成（`broadcasts.test.tsx`）・行きたいの作成（`wishes.test.tsx`）も同じ部品の状態になる
- [ ] シートの差し替え：`swapSheet` で移った先の `BottomSheet` は入る動きの印を持たず、止めない設定では前の高さ（px）の `height` から始まり、詳細の読み込み中（骨組み）のあいだはその高さのまま、中身が描けたら測った高さ（px）の `height` に替わり（`auto` にしない）、保険のタイマーのあとに `height` の指定が外れる。動きを止める設定では `height` を付けない。覚えた高さは2回読んでも同じ値（`StrictMode` で初期化が2回走っても）で、次の `navigate` のあとは使われない
- [ ] M-04（`apps/web/src/pages/meetMoment.test.tsx` に足す）：「行く」を押すと、返答のボタン群が `Collapse` の閉じる側になり、バッジに `kh-badge-pop` が1回付く（楽観的更新のとき）。送れなかったときはボタン群が戻り、静かな文言が出て、バッジは動かない（応答が閉じる動きより早く失敗しても、ボタン群が消えない）。「今回は難しい」ではバッジが動かない。**詳細を開いたまま、取り直し（`refetch`）で相手の操作により成立に変わったときは、バッジに `kh-badge-pop` が付かない**（自分の操作のときだけ）。T-43 の演出の条件（応答を待つ・1回だけ・見た記録）は既存のテストのまま通る
- [ ] M-04：成立した予定を見るが `meet` の塗りのボタン（`ButtonLink`、`bg-meet`）で1つだけ（誘いの詳細・募集の詳細）。一覧のカードのバッジは動かない。募集の宛先の人で予定の参加者でない人には、ぽんも予定を見るボタンも出ない
- [ ] 結果の帯（`apps/web/src/ui/ResultBand.test.tsx`。T-55 の `UndoToast.test.tsx` を移して足す）：画面に1つだけ。`show` で出て、文だけは3.5秒・「取り消す」つきは6秒で消える。同じ文を2回 `show` すると、入る動きからもう一度出る（要素が作り直される）。乗せている間・フォーカスの間は消えない。`role="status"` の場所はいつもある。シートを開いているときもシートの上に出る。`show` を呼んでも、`useResultBand` を使う部品は描き直されない（描いた回数を数える）。動きを止める設定では、入る動きなしにすぐ見える（普段の指定に `opacity-0` がない）
- [ ] お知らせの「見せないにしました」とカレンダー連携の結果が、結果の帯に出て、本文の流れに `Toast` を置かない（`notifications.test.tsx`・`calendar.test.tsx`）
- [ ] 今ひま（`freeNow.test.tsx`）：「元に戻す」の5秒と文言は今のまま（既存のテストが通る）
- [ ] M-12（`AvailabilityChip`）：止めない設定で、重なる枠が画面に入ったら1回だけ灯る印が付き、同じ枠を描き直しても・見えなくなってまた入っても、もう一度付かない。重ならない枠には付かない。動きを止める設定・`IntersectionObserver` がない環境では、最初から灯った見た目
- 他人のIDでは取得・更新できない：API を変えないので対象外

#### 実装PR③：一覧とナビ
- [ ] M-05（`apps/web/src/App.test.tsx` か `login.test.tsx`）：確認中に `/invites` を開くと、ヘッダー「誘い」と下のタブ（`inert`）と骨組みが出て、未読の数の API を呼ばない。確認が終わったあともヘッダーと下のタブが同じ要素の位置に出る（作り直さない、または同じクラスで同じ並び）。`/settings` の確認中は今の `PageLoading`
- [ ] M-06：`Loading` の3つの形。`role="status"`・`aria-label="読み込み中"` が最初の描画からある。骨組みの数は件数によらず同じ。骨組みの普段のクラスに `opacity-0` がなく（動きを止める設定で `animation: none` になっても見える）、`index.css` の `kh-fade-in` は `from` だけ・`backwards` で付いている。`FadeIn`・`EmptyState`（M-19）も同じ
- [ ] M-07（`navigation.test.tsx`）：今いるタブのアイコンが塗りの版で、線は `bg-ink`、`lamp` 系のクラスがない（PC の左のナビも）。今いるタブを押すと `scrollTo` が `top: 0` で呼ばれ（動きを止める設定では `behavior: "auto"`）、URL は変わらない。別のタブから戻ると前の位置で `scrollTo` が呼ばれ、初めてのタブは0。`aria-current="page"` は今のまま
- [ ] `tabScroll` の関数：覚える・初めては0・タブごとに別。`scrollTargetOnPop`：エントリの位置があればそれ、なければタブの位置、どちらもなければ0
- [ ] M-07（`navigation.test.tsx`）：友達タブでスクロールして設定を開き、戻る（`history.back()`→`popstate`）と、友達タブの前の位置で `scrollTo` が呼ばれる。設定 → 設定の下の画面 → 戻るでも、設定の前の位置に戻る。`history.scrollRestoration` が `"manual"`
- [ ] `transitionKind`：シートが関わると none、タブどうしは fade、設定へは push、戻るは pop。`depth` の比べ方（popstate で戻ると pop、進むと push、外から直接開いたときは0）。`hasUAVisualTransition` が true の popstate は none
- [ ] View Transitions：`startViewTransition` がない・動きを止める設定では、そのまま移る（既存のテストのまま通る）。ある場合は呼ばれ、向きの印（`data-nav`）が付く。下のタブ・左のナビに `view-transition-name` が付き、中身の領域に `kh-content` が付く
- [ ] M-08（`invites.test.tsx`）：白い板が1枚で、`?tab=` に合わせた番号の位置になる。URL と `aria-current` は今のまま
- [ ] M-10：自分の操作（くり返しの削除・行きたいの削除・招待リンクの無効化）で消える行が `Collapse` の閉じる側になり、止めない設定では保険のタイマーのあとに消える。失敗して戻ると、元の場所に戻る。増えた行は1回だけ光る。友達の側の一覧（みんなタブ）では、行が消えても `Collapse` を使わない
- [ ] M-11：カード・行・顔に押した感触のクラスがあり、`outline` を書き換えない（`focus.test.ts` に足す）。`index.css` に `-webkit-tap-highlight-color: transparent`
- [ ] M-15：未読の数が増えたときだけぽんの印が付き、最初の描画と減ったときは付かない
- [ ] M-17：日付の見出しに `sticky` が付く（`everyone.test.tsx`）
- [ ] M-18：スイッチのつまみの動きがトークンで書かれている
- [ ] M-19：`EmptyState` に入る動きのクラスが付く
- [ ] V-1：受信の誘いの詳細で、バッジが名前と同じ行ではなく、種類の文字の行にある（募集の詳細も）
- [ ] V-2：オフラインになると帯が `Collapse` の開く側で出る
- 他人のIDでは取得・更新できない：API を変えないので対象外

### E2Eテスト（対象にする利用者の流れ）
- [ ] 実装PR①：既存の E2E（`e2e/navigation.spec.ts` ほか、`toHaveCount(0)` でシートが閉じたことを見ているもの）が、動きを付けたまま通る。通らなければ待ち方を直すのではなく、動きの長さを見直す。
  - **例外**：`e2e/desktop.spec.ts` の PC の中央のダイアログの大きさの確かめ（シートが見えた直後に `boundingBox()` を取り、幅が512pxかを見ている）は、入る動き（`scale(.96) → 1`）の途中だと `transform` のぶん幅が小さく測れるので、長さを変えても直らない。ここだけは、入る動きが終わってから測るように直す（`await expect.poll(async () => (await detail.boundingBox())?.width).toBe(512)`、または `detail.evaluate((el) => el.getAnimations().length === 0)` を待ってから測る）。ほかに見つかった大きさ・位置の確かめも同じ扱いにし、実装PRの説明に挙げる。
  - `e2e/navigation.spec.ts` に、シートを「閉じる」で閉じたあと開いたボタンにフォーカスが戻ることを、動きのある設定で確かめる（今のテストが動きを止めていないことを確かめる）
- [ ] 実装PR②：`e2e/invites.spec.ts` の誘い〜成立の流れで、「誘う」のあと詳細のシートが開き（シートが1つだけ）、「行く」のあと「成立した予定を見る」のボタン（`getByRole("link", { name: "成立した予定を見る" })`）から予定を開ける。既存の T-43 の演出の確かめはそのまま
- [ ] 実装PR③：`e2e/navigation.spec.ts` に、みんなタブを下へスクロールして誘いタブへ移り、みんなタブに戻ると位置が戻ること、今いるタブを押すと一番上に戻ることを足す。ログインの確認中（`page.route` で確認の応答を遅らせる）に、ヘッダーと下のタブが出ていることと、確認中と確認後でヘッダーと下のタブの `boundingBox()`（x・y・幅・高さ）が同じこと（M-05 の「1pxも動かない」。スマホの幅と PC の幅の左のナビの両方）を足す
- WebKit（`@iphone`）では新しく回さない（動きは CSS と View Transitions で、対応しない端末では即時になるだけ。ブラウザごとの差は単体テストと Chromium で足りる）
- 動きの見た目そのものは自動のテストにしにくいので、各実装PRの説明に「前／後」の画面の連番か動画を付ける

## スコープ外
- アニメーションのライブラリ（`motion` など）を入れること（「判断してほしいこと」1）。
- 全画面の成立の祝い・紙吹雪・音・振動（M-04・M-20）。
- T-43 の成立の演出そのものの変更（長さ・色・並べ方・流す条件・「見た」の記録）と、一覧での成立の演出。
- 中身のスクロールが一番上のときに、中身から下へ引いてシートごと下げる操作（M-02）。
- 誘いタブの中身の左右のスワイプでの切り替え（M-08）。
- 取り消しの「元に戻す」を、T-55・T-40 にあるもの以外に足すこと（M-10）。
- ブラウザの戻る（popstate）でシートを閉じたときの下へ抜ける動き（M-01）。
- 空の状態の絵を画面ごとに変えること（M-19）。
- オフラインでも読めるキャッシュ、テーマを手で切り替える設定（T-11 のまま）。

## 確認事項（合意前に解消する）
- T-55（ここ暇タブの週の帯）がまだ main に入っていない。M-03・M-09・M-10 のここ暇の部分は T-55 の画面（`WeekPlanner`・`TimeRangeSheet`・`CellSheet`・`UndoToast`）を前提に書いた。実装PR②・③は T-55 の実装PRが main に入ってから作る。T-55 の仕様が変わったら、この仕様書を実装PRで直す。

## 判断してほしいこと
1. アニメーションのライブラリを入れるか。(a) 入れない／(b) `motion` を入れる。推奨：(a)。今の動きの量なら CSS と View Transitions で足り、バンドルも増えない。指につく引っぱり（M-02）だけ小さな自前のフックで書く。
2. M-04 の成立の強さ。(a) 控えめ（バッジのぽん＋帯だけ）／(b) 中／(c) 大（全画面の祝い）。推奨：(b)。T-43 の演出（丸が寄って重なる）を正とし、足りない部分（ボタン群の退場・`meet` の塗りの「成立した予定を見る」・バッジのぽん）だけを足す。(c) は気軽さと合わない。
3. M-08 誘いタブの中身を左右のスワイプで切り替えるか。(a) しない／(b) する。推奨：(a)。シートを下に引く操作や、横に並ぶ「誰を誘う？」と指の動きがぶつかる。
4. M-10 取り消しに「元に戻す」を付けるか。(a) 動きだけ／(b) 結果の帯に「元に戻す」を付ける。推奨：(a)。(b) はサーバーの振る舞いが変わる（取り消しを遅らせるか作り直す）ので別のタスク。T-55 のここ暇の「取り消す」と T-40 の今ひまの「元に戻す」はそれぞれの仕様のまま。
5. M-20 振動させるか。(a) しない／(b) Android だけ `navigator.vibrate`。推奨：(a)。iPhone の Safari では使えず、端末で体験が割れる。
6. M-01 ブラウザの戻る（popstate）でシートを閉じたときの動き。即時／View Transitions で下へ抜く。推奨：即時。無理に合わせると戻るの反応が遅れる。
7. M-05 ログインの確認中、ログインしていない人にも殻（ヘッダーと下のタブ）を見せてよいか。推奨：見せてよい。確認は通常すぐ終わり、殻にはタブの名前しか出さない。
8. M-04 楽観的更新との関係。成功を待たずに出す／成功を待つ。推奨：成功を待たずに出し、失敗したら静かに戻す（ボタン群の退場とバッジのぽんは楽観的更新のときに出し、送れなかったらボタン群を元の場所に戻す）。T-43 の丸の演出は、予定の ID がサーバーの応答で入るので、今までどおり応答を待つ。
9. 「ついでに見つけた見た目の崩れ」（V-1 誘いの詳細のヘッダーで名前が切れる、V-2 オフラインの帯で中身が下がる）を、このタスクの流れ（実装PR③）で直すか。推奨：直す。どちらも同じ部品（`Collapse`・詳細の見出し）を触るので、別のタスクに分けると二度手間になる。
10. PC の左のナビの「今いる場所」の `bg-lamp-soft`（T-20）もやめるか（指示書は「黄色はタブには使わない」）。推奨：やめて `bg-head`＋塗りのアイコンにする（スマホの下のタブと同じ考え方。T-20 の記述も直す）。
11. シートの出る動きの長さ（0-2・M-01。指示書の叩き台と違う）。(a) `--duration-base`（240ms。入る動き 360ms の1段下）／(b) 叩き台どおり `--duration-fast`（160ms）。推奨：(a)。出る動きは入る動きの約7割という決まりにそろう。E2E は消えるのを待つので 240ms でも通る。閉じる反応をもっと軽くしたいなら (b)（決まりの例外になる）。
12. M-02 の、中身のスクロールが一番上のときに中身から下へ引いてシートごと下げる操作（指示書は「やる。後回しも可」）。(a) このタスクではやらない（スコープ外）／(b) 実装PR①でやる。推奨：(a)。ブラウザのスクロールとぶつかり、`touchmove` を止める作り（iOS の慣性スクロールとの調整）が要るので、つまみと見出しの行の引っぱりを入れて使われ方を見てから、別のタスクで決める。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-24 | 初版 | 持ち主の指示書「ここ暇のUIの『動き』と『手触り』を、よくできたアプリの水準に上げる」 |
| 2026-11-24 | 仕様書PRのレビューで直した：`matchMedia` を差し替えている既存のテストと SettingsPage の判定を `prefersReducedMotion` にそろえる（0-3）。`useExitAnimation` に `cancel()` と、`done` のあとまた `start` できることを足した。シートの `ref` はシートに付け、暗い背景を別の層にした（M-01）。見出しの行からのタップでは閉じない・リンクも引っぱりにしない（M-02）。差し替えの高さは px から px で、読み込み中は高さを保つ・`StrictMode` で2回読んでも同じ（M-03）。入る動きは普段の指定を最終形にし、骨組みは動きを止める設定ですぐ見える（0-1 の4・M-06）。バッジのぽんは自分の操作のときだけ（M-04）。結果の帯の context は `show` だけ（M-09）。スクロールの位置を履歴のエントリごとにも戻す（M-07・M-13）。`hasUAVisualTransition` では動かさない・ナビは動かさない（M-13）。トークンへ移す今の動きと T-43 の例外、直書きの検査を広げた（0-1 の5）。E2E の大きさの確かめと M-05 の位置の確かめを足した。判断してほしいこと 11・12 を足した。T-11・T-54 に T-56 で変わるところの注記を足した | 仕様書PRのレビュー（pryusei/kokohima-app#216） |
