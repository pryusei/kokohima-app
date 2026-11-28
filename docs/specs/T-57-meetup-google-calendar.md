# T-57 仕様書：成立した予定から Google カレンダーに入れる

- 状態：実装済み（実装PR。仕様書PR pryusei/kokohima-app#225。マージ前なので、台帳 docs/tasks/REGISTRY.md では「作業中」）
- タスク票：docs/tasks/T-57-meetup-google-calendar.md
- 関係する要件：F-13（成立した予定をカレンダーに入れる）、F-02（カレンダー連携）、要求定義書「デザイン原則」
- 関係する仕様書：T-06（docs/specs/T-06-calendar.md「成立した予定のGoogleカレンダーへの書き込み」「画面」の「予定の詳細」）、T-04・T-05（成立した予定の詳細）、T-43（docs/specs/T-43-meet-moment.md。成立の演出の中の .ics）、T-11（docs/specs/T-11-design.md。トークンと部品）、T-56（docs/specs/T-56-motion.md。M-09 の結果の帯）

## 概要
> 画面の欄（連携の状態ごとの1行とボタン、「自動で入ります」）は、T-59（docs/specs/T-59-choose-calendar-add.md）で「カレンダーに追加」に置き換えた。自動の書き込みもやめた。連携の開始の `meetupId` と戻り先の処理は残している（T-59 のスコープ外）。

成立した予定の画面には「カレンダーに追加（.ics）」しかなく、Google カレンダーに入ることが画面のどこにも出ない。そのため、持ち主から「Googleカレンダーに追加が出てこない」と見えている。実際には、設定で連携している人の予定は、成立のときに裏で自動で「ここ暇」カレンダーに入る（T-06）。
成立した予定の画面に、閲覧者自身の Google カレンダーの連携の状態に応じた1行または1つのボタンを出す。連携していない人は、その場から連携を始め、終わったらこの予定の画面に戻れるようにする。.ics は Apple などの人のために残す。

## 前提
- 書き込みの仕組み（outbox → Queues → consumer、`CalendarConnected` でこれからの予定をまとめて書く）は T-06 のまま変えない。
- **画面は、その予定が Google に書けたかどうかを知れない**。T-06 の consumer は予定ごとの書き込みの結果を保存していない（`calendar_connections` にあるのは連携の状態と `calendar_id` だけ）。そのため、連携中の文言は「入っています」ではなく「自動で入ります」にする（決めたこと1）。
- 連携の状態は、今の `GET /api/v1/calendar/connections`（閲覧者自身の行だけ）で分かる。状態を読む新しい API は作らない。
- Google から予定の中身を読まない（T-06 と同じ）。

## 用語
`invitation-domain` スキルの用語表と T-06 の用語に合わせる。

| 画面 | コード | 備考 |
| --- | --- | --- |
| 成立した予定 | Meetup | |
| 「ここ暇」カレンダー | （Googleのセカンダリカレンダー） | T-06 |
| カレンダー連携 | CalendarConnection | T-06 |
| カレンダーへの入れ方の欄 | `MeetupCalendarActions` | 新しい部品。`IcsButton` を中に持つ |

## API
`api-conventions` スキルに従う。変えるのは連携の開始とコールバックだけ。スキーマは `packages/shared/src/schemas/calendar.ts`。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/calendar/google/authorizations` | Bearer（`requireActiveSession`） | 本文（任意）：`calendarAuthorizationRequestSchema` `{ meetupId?: uuid }` | 200：`{ authorizeUrl }`、結びつけCookie（今のまま） | 400 `validation_failed`、401、429 `rate_limited` |
| GET | `/api/v1/calendar/google/callback` | なし（state と結びつけCookie） | 今のまま | 303：戻り先（下の「戻り先」）に `?calendar=connected` か `?calendar=failed` | （常に303） |
| GET | `/api/v1/calendar/connections` | Bearer | なし | 今のまま | 401 |

### 入力
- `calendarAuthorizationRequestSchema = z.object({ meetupId: z.uuid().optional() }).strict()`。
  - 本文なし・空の本文・`{}` は今と同じ（戻り先は設定）。設定の画面は今のまま本文を送らない。
  - `meetupId` が UUID でない、知らない項目がある、JSON でない本文は 400 `validation_failed`。
- **`meetupId` の予定に閲覧者が参加しているかは、ここでは確かめない**（決めたこと4）。確かめて 404 を返すと、予定の ID があるかどうかを確かめる手段になるため。参加していない予定の ID を入れても、応答は同じ200で、戻った先の予定の画面が今までどおり「この予定は見つかりませんでした」を出すだけ。

### 戻り先
- `meetupId` があれば `<APP_ORIGIN>/meetups/<meetupId>`、なければ `<APP_ORIGIN>/settings/calendar`。どちらにも `?calendar=connected` か `?calendar=failed` を付ける。
- 戻り先は、`calendar_oauth_states` の行に保存した `meetupId`（UUID として検証済み）だけから組み立てる。URL やパスを外から受け取らないので、任意の場所へのリダイレクト（オープンリダイレクト）にならない。
- `state` がない・行が見つからない・期限切れ・使用済みのときは、戻り先を知れないので設定（`/settings/calendar?calendar=failed`）へ。行を取り出せたあとの失敗（結びつけCookieの不一致・同意画面で断った・スコープ不足・トークンの交換の失敗・想定外の失敗）は、行の戻り先へ `?calendar=failed`。失敗の理由は、今までどおり画面で区別しない。
- 想定外の失敗（例外）も、行を取り出せたあとなら行の戻り先へ戻す。今はコールバックのルート（`routes.ts`）が例外を受け、`completeConnect` は真偽だけを返すので、実装では `completeConnect` が戻り先（`return_meetup_id`）を結果と一緒に返すか、例外を `completeConnect` の中（行を取り出したあと）で受けるようにする。

## データ
マイグレーションを1つ足す（`apps/api/migrations/0021_calendar_return_meetup.sql`）。

### `calendar_oauth_states`
- `return_meetup_id`（TEXT、NULL 可）を足す。連携の開始で受け取った `meetupId`。外部キーは付けない（予定が消えても、行は10分で掃除される。T-06）。
- 保持期間は今の行と同じ（作成から10分で消す。T-06「outbox を Queues に流す」の掃除）。保存する情報の種類が増えるわけではない（自分が見ている予定の ID を10分だけ持つ）ので、プライバシー ポリシー・`packages/shared/src/retention.ts` は変えない。

ほかの表は変えない。予定ごとの書き込みの結果は保存しない（「スコープ外」）。

## 振る舞い

### 1. 欄を出す場所
- 成立した予定の詳細（`/meetups/{id}`。`MeetupDetailPage`）の、今 `IcsButton` がある場所。
- 誘いの詳細・募集の詳細の成立の演出の中（T-43。`MeetMoment` の子。今 `IcsButton` がある場所）。
- どちらも `IcsButton` を `MeetupCalendarActions`（`apps/web/src/calendar/`）に置き換える。`MeetupCalendarActions` は予定（`Meetup`）を受け取り、中で `connectionsQuery()` を読む（TanStack Query。設定・ここ暇タブと同じキーなので、たいていはすでに持っている）。

### 2. Google の行を出す条件
- 出すのは、予定が `confirmed` で、終了が画面を開いた時刻より後（これからの予定）で、連携の状態を読めたときだけ。
  - 取り消された予定・抜けた予定（抜けた人には `cancelled` で返る。T-05）・終わった予定には出さない。Google に入れる対象でないため（T-06「書くべき予定」）。
  - 連携の状態を読んでいる間・読めなかったときは、Google の行を出さない（失敗の文言も出さない。.ics だけの今の画面と同じになる）。
- 時刻は、画面を開いた時刻で1回だけ判定する（今の「やっぱり難しい」の判定と同じ。描画のたびに時計を読まない）。

### 3. 連携の状態ごとの見た目
「Google の行を出す」ときは、状態に応じて次のどれか1つを出す。

| 状態（`google.status`） | 出すもの |
| --- | --- |
| `connected` | 静かな1行（`Note`）「連携中なので、Googleカレンダーの『ここ暇』に自動で入ります」 |
| `none` | 主のボタン（`SendButton` `variant="primary"` `block`）「Googleカレンダーに自動で入れる」と、その下に静かな1行「連携すると、これからの予定もまとめて入ります。読むのは空き／埋まりだけです」 |
| `needs_reauth` | 静かな1行「Googleカレンダーに入れるには、もう一度連携してください」と、設定へのリンク「カレンダー連携へ」（`/settings/calendar`。`ui/Link`） |

- 色はトークンだけ（`text-ink-muted` など）。赤・エラー色・黄色の注意は使わない（T-11）。
- `connected` の1行に、書けたかどうかの印（✓ など）は付けない（画面は書けたかを知れないため。前提）。

### 4. 「Googleカレンダーに自動で入れる」を押したとき
1. `POST /api/v1/calendar/google/authorizations` に `{ meetupId: <この予定の ID> }` を送る（設定の「Googleカレンダーと連携」と同じ処理に本文を足すだけ）。
2. 返った `authorizeUrl` へ画面遷移する（`redirectTo.go`。T-06 と同じ）。
3. 送信中はボタンを送信中にする（`SendButton` の `pending`。T-56 M-14）。オフラインでは押せない（T-11）。
4. 失敗したら、ボタンの下に静かに「連携を始められませんでした。もう一度お試しください」（設定と同じ文言）。回数の上限（429）は「少し待ってから、もう一度お試しください」（`IcsButton` と同じ）。
5. 同意すると、T-06 のコールバックで連携が保存され、`CalendarConnected` でこれからの予定（この予定を含む）がまとめて「ここ暇」カレンダーに入る。T-06 の書き込みの仕組みは変えない。

### 5. 戻ってきたとき（`/meetups/{id}?calendar=…`）
- `App.tsx` の `sheetOf` で、`MeetupDetailPage` に `search` を渡す。
- `?calendar=connected`：結果の帯（`useResultBand`。T-56 M-09）に「連携しました。Googleカレンダーの『ここ暇』に入ります」。連携の状態（`keys.calendar.connections()`）は読み直すので、欄は `connected` の1行になる。
- `?calendar=failed`：結果の帯に「連携できませんでした。もう一度お試しください」（設定と同じ文言）。欄は `none`（または `needs_reauth`）のまま。
- 同じ結果は、開いている間に1回だけ出す（設定の画面と同じ作り。`useRef`）。
- 外から直接開いたときと同じく、後ろのタブは誘いタブ（T-11「画面のつながり」）。
- 設定の画面（`/settings/calendar?calendar=…`）の表示は今のまま。

### 6. 「カレンダーに追加（.ics）」
- 残す。動き（`ics-links` を発行して画面遷移）・失敗の文言は T-06 のまま。
- Google の行を出しているときは、Google の行の下に置き、文言を「ほかのカレンダーに追加（.ics）」にする（副のボタン。`SendButton` の既定の `secondary`）。Apple などの人のため。
- Google の行を出していないとき（取り消し・終わった予定、連携の状態を読んでいる間・読めなかったとき）は、今と同じ「カレンダーに追加（.ics）」。

### 7. 並び
- 成立した予定の詳細：リンクのカードの下に、Google の行 → .ics の順。その下の「やっぱり難しい」は今のまま。
- 成立の演出の中：今の .ics の場所に、Google の行 → .ics の順。「成立した予定を見る」（T-56 M-04）は今の場所に1つだけ。

### 8. 変えないこと
- Google からは、予定の中身・カレンダーの一覧を読まない（T-06 のスコープのまま）。
- 連携の開始の回数の上限（1人につき10分に10回）、結びつけCookie、`state` の扱いは T-06 のまま。

## 認可と秘匿
- 閲覧者IDの使い方：連携の状態は、今の `GET /api/v1/calendar/connections`（`user_id = 閲覧者` の行だけ）で読む。連携の開始は `requireActiveSession` の閲覧者で `calendar_oauth_states` に行を足し、コールバックは `state` に結びつけた利用者に保存する（T-06 のまま）。
- 他人のデータに届かないことの保証：
  - 欄に出すのは閲覧者自身の連携の状態だけ。ほかの参加者が連携しているかは、API にも画面にも出さない。
  - `meetupId` は戻り先のパスに使うだけで、予定の中身を読まない。戻った先の予定の画面は、今までどおり閲覧者が参加者の予定だけを返す（`findMeetupFor`）。
  - 戻り先は保存した UUID から組み立てるので、外のサイトや任意のパスへは戻らない。別の人が始めた連携の `state` は、結びつけCookieが一致しないので使えない（T-06）。
- 区別させない応答：
  - `meetupId` が、閲覧者の予定・他人の予定・存在しない ID のどれでも、連携の開始の応答（200 と `authorizeUrl`）とコールバックの戻り方は同じ。予定があるかどうかを確かめる手段にならない。
  - 友達から見える情報は変わらない（閲覧者が連携しているかを友達に返さない。T-06）。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] API：`meetupId` 付きで始めると、`calendar_oauth_states.return_meetup_id` に入り、コールバックの成功で `/meetups/<id>?calendar=connected` へ303、行を取り出したあとの失敗（結びつけCookieの不一致・`error`・スコープ不足）で `/meetups/<id>?calendar=failed` へ303
- [x] API：本文なし・`{}` で始めると、今までどおり `/settings/calendar?calendar=…` へ303。`state` がない・期限切れ・使用済みは `/settings/calendar?calendar=failed`
- [x] API：`meetupId` 付きで行を取り出したあと、トークンの交換か保存で想定外の例外が起きても、`/meetups/<id>?calendar=failed` へ303（`/settings/calendar?calendar=failed` にならない）
- [x] 入力検証：`meetupId` が UUID でない、知らない項目、JSON でない本文は 400 `validation_failed`。行は足さない（回数の上限に数えない）
- [x] 他人のIDでは取得できない：他人の予定の ID・存在しない ID を `meetupId` にしても、応答は自分の予定のときと同じ200（形・項目が同じ）。戻った先の `GET /api/v1/meetups/{id}` は今までどおり404
- [x] 他人のIDでは取得できない：利用者 A の連携の状態は、B が連携していても A の行だけから返る（`GET /calendar/connections`。T-06 の既存のテストで足りていればそれを使う）
- [x] 戻り先がオープンリダイレクトにならない：`meetupId` に `//evil.example` や `../` を入れても400で、303 の `Location` は常に `APP_ORIGIN` の `/meetups/<uuid>` か `/settings/calendar`
- [x] 画面（`MeetupCalendarActions`）：`connected`・`none`・`needs_reauth` のそれぞれの文言とボタン・リンク。.ics の文言が「ほかのカレンダーに追加（.ics）」になる
- [x] 画面：取り消した予定・抜けた予定（`cancelled`）・終わった予定、連携の状態を読んでいる間・読めなかったときは Google の行を出さず、.ics は「カレンダーに追加（.ics）」
- [x] 画面：「Googleカレンダーに自動で入れる」で `{ meetupId }` を送り、`authorizeUrl` へ移る（`redirectTo` を差し替える）。失敗・429 は静かな文言。赤・エラー色のクラスがない
- [x] 画面：`/meetups/{id}?calendar=connected`・`failed` で結果の帯が1回だけ出て、連携の状態を読み直す
- [x] 成立の演出の中（誘いの詳細・募集の詳細）にも同じ欄が出て、「成立した予定を見る」は1つだけ（`meetMoment.test.tsx` を直す）

### E2Eテスト（対象にする利用者の流れ）
- [x] `e2e/calendar.spec.ts`：連携していない人が、成立した予定の詳細で「Googleカレンダーに自動で入れる」→ 偽の認可画面 → 同じ予定の画面に戻り、「連携しました…」の帯と「連携中なので、Googleカレンダーの『ここ暇』に自動で入ります」が出るところまで。この予定が Google に書かれることは、書き込みの仕組みを変えないので E2E では確かめず、`calendar.test.ts` の既存の単体テスト（`CalendarConnected` でこれからの予定を書く）で確かめる（E2E の偽の Google は予定の書き込みを受け付けるだけで記録しない）
- [x] `e2e/calendar.spec.ts` の .ics の流れと `e2e/invites.spec.ts` の成立の演出：ボタンの名前を「ほかのカレンダーに追加（.ics）」に直す

## 実装PRで直す文書
- docs/specs/T-06-calendar.md：API の表（連携の開始の本文、コールバックの303の行き先）、`calendar_oauth_states` の列、「画面」の「予定の詳細」をこの仕様書の振る舞いに合わせる。
- docs/specs/T-43-meet-moment.md：演出の中の「カレンダーに追加（.ics）」を、この仕様書の欄（`MeetupCalendarActions`）に直す（「Google カレンダーへの書き込みは今のまま自動」の行も）。
- docs/specs/T-04-direct-invite.md「画面」の成立した予定：Google の欄を足したことを1行で書く。

## スコープ外
- 予定ごとに Google に書けたかどうかを保存して、「入っています」と言い切ること（決めたこと1）。新しい表（例：利用者×予定の書き込みの記録）と consumer の変更が要る。
- 「Googleカレンダーで見る」（Google カレンダーのその予定を直接開くリンク。決めたこと3）。
- 予定の詳細から連携をやめること（設定でだけ行う）。
- Apple カレンダーの連携（T-09）。
- Google のカレンダーに書く内容（タイトル・場所・説明）の変更。

## 決めたこと（仕様書PRで判断してもらう。返事がなければこのとおり）
1. 連携中の文言。(a)「連携中なので、Googleカレンダーの『ここ暇』に自動で入ります」（今のデータで言えること）／(b)「Googleカレンダーの『ここ暇』に入っています」（予定ごとの書き込みの記録を新しく持つ）。**推奨：(a)**。(b) は表と consumer の変更が要り、書き込みが数分遅れる間や失敗の間に「入っています」が事実と違ってしまう。
2. 連携していない人のボタンの押した先。(a) その場で Google の同意画面へ（設定の「Googleカレンダーと連携」と同じ処理）／(b) 設定のカレンダー連携の画面へ移るだけ。**推奨：(a)**。ボタンの下の1行で「これからの予定もまとめて入る」「読むのは空き／埋まりだけ」を伝える。
3. 「Googleカレンダーで見る」。予定の ID（`kh`＋UUID）と `calendar_id` から Google カレンダーの Web の URL は作れるが、`calendar_id` を新しく画面に渡すことになり、書けたかも分からず、スマホの Google カレンダーのアプリで開けるとも限らない。**推奨：今回はスコープ外**。
4. 戻り先。(a) 連携の開始の本文で `meetupId` を受け取り、`calendar_oauth_states` に保存して、コールバックでこの予定の画面へ戻す／(b) 戻り先は設定のまま。**推奨：(a)**。戻り先は `state` に結びついたサーバーの行（10分で消える）に置くので、端末の保存領域（プライベート ブラウズや保存の制限で使えないことがある）に頼らず、外から URL も受け取らない。参加しているかは確かめない（予定の有無を確かめる手段にしないため）。
5. もう一度連携が要るとき（`needs_reauth`）。(a) 静かな1行と設定へのリンク／(b) `none` と同じボタンでその場で連携し直す。**推奨：(a)**。切れた理由の確かめと「連携をやめる」が設定にあるため。
6. 成立の演出の中（誘いの詳細・募集の詳細）にも同じ欄を出すか。(a) 出す／(b) 成立した予定の詳細だけ。**推奨：(a)**。成立した直後がいちばん入れたいときで、.ics もすでに演出の中にある。戻り先は、どちらから押しても成立した予定の画面（`/meetups/{id}`）。

## 確認事項（合意前に解消する）
- なし（上の「決めたこと」を仕様書PRで判断してもらう）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-24 | 作成 | 持ち主の指摘（成立した予定の画面に Google カレンダーに入れる方法が出てこない） |
| 2026-11-24 | E2E を結果の帯と連携中の1行までにし、書き込みの確認は既存の単体テストに任せた。想定外の例外のときの戻り先と、その単体テストを足した。決めたこと4の理由を直した | 仕様書PRのレビュー |
| 2026-11-24 | 実装した（マイグレーション 0021。「判断してほしいこと」は推奨のとおり） | 実装PR |
| 2026-11-24 | 「カレンダー連携へ」をほかの文中のリンクと同じ見た目（`text-action underline`）にした。送信中とオフラインのボタンの単体テストを足した | 実装PRのレビュー |
| 2026-11-28 | 画面の欄を T-59 で置き換えたと注記した | T-59 実装PR（docs/specs/T-59-choose-calendar-add.md） |
