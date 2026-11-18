# T-08 仕様書：リンクのプレビュー（OGP）

- 状態：下書き
- タスク票：docs/tasks/T-08-link-preview.md
- 関係する要件：F-15、NF-02、要求定義書「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」「Link Preview：OGP取得、画像プロキシ」、セキュリティ設計「外部への取得（OGP）」。issue pryusei/kokohima-app#47

## 概要
- 誘い・募集にリンクが付いていたら、送ったあとに consumer がそのページを取り、OGP（タイトル・説明・サイト名・画像）を保存する。画像は R2 に保存し、アプリの経路から配信する。
- 詳細の画面（誘い・募集・成立した予定）に、カード（タイトル・説明・画像・ドメイン）を出す。取れるまでと、取れなかったときは、今と同じドメインだけ。
- 作成画面での送る前のプレビューはしない（決定事項1。外部への取得を consumer の1か所にまとめるため）。

## 前提

### コンテキストの分担
- 新しいコンテキスト `link-preview`（`apps/api/src/link-preview/{domain,application,infra}`）。
  - domain（純粋）：URL の検査（取りに行ってよいか）、IP アドレスの検査（プライベートなどか）、HTML からの OGP の取り出し、文字列の整え方、画像の種類の判定（先頭のバイト）。
  - infra：取得（`AppDeps.fetch`）、名前解決（DNS over HTTPS）、D1、R2。
  - application：イベントから取得して保存する処理、画像の配信、invitation から呼ぶ読み取り。
- invitation は、誘い・募集の作成の batch に outbox の `LinkAttached` を足す。応答の DTO に、link-preview の application の関数で読んだプレビューを足す（invitation は link-preview の表を直接読まない）。

### 公式で確かめたこと（2026-11-18）
- Workers の `fetch` は、IP アドレスあての URL を直接は取れない（URL のホスト名で取る）。
- `global_fetch_strictly_public` の互換性フラグがないと、自分のゾーンあての `fetch` は、Cloudflare のセキュリティ設定を飛ばしてオリジンに届く。このフラグには既定で有効になる日付がないので、wrangler の `compatibility_flags` に明示して付ける（決定事項3）。ほかの外部呼び出し（Google・Resend・プッシュ）は公開のホストなので影響しない。
- `redirect` は `follow` か `manual`。`manual` にして、リダイレクトを自分で数えて検査する。
- Workers は応答の大きさを制限しないので、読む量は自分で打ち切る。
- R2 の書き込み・削除は強い整合性（書き終えたら、どこからでも読める）。`put` にストリームを渡すときは長さが要るので、読み終えた `ArrayBuffer` を渡す。
- 1回の呼び出しの外部の取得（サブリクエスト）は、有料プランで10,000まで。1件の取得は、名前解決とリダイレクトを入れても十数回に収まる。

## API
`api-conventions` スキルに従う。

| メソッド | パス | 認証 | 入力 | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/link-previews/images/{imageId}` | なし（推測できない ID。`<img>` で読むため） | なし | 200：画像（`image/jpeg`・`image/png`・`image/webp`・`image/gif`） | 404（ない・壊れた ID） |

- 既存の経路の応答に、`linkPreview` を足す（`packages/shared` の `linkPreviewSchema`）。
  - `GET /direct-invites/{id}`・一覧、`GET /broadcasts/{id}`・一覧、`GET /meetups/{id}`・一覧。
  - 形：`{ status: "pending" | "ok" | "failed", title: string | null, description: string | null, siteName: string | null, imageUrl: string | null }`。リンクがなければ `linkPreview: null`。
  - `status` は、取得前が `pending`、取れたら `ok`、取らない・取れなかったら `failed`。`failed` のときは、項目はすべて null（理由は返さない）。
  - 見える人は、今の `url` と同じ（誘い・募集・予定を見られる人だけ）。他人の ID では、今までどおり404。
- 画像の経路の応答のヘッダー：`Content-Type`（保存した種類）、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: public, max-age=86400, immutable`、`Cross-Origin-Resource-Policy: same-origin`、`Content-Disposition: inline`。
- 画像の経路は `/api/v1/ics/{token}` と同じく Rate Limiting の `RL_PUBLIC`（IP）を付ける（まとまりの名前 `link_image`）。超えたら本文なしの429。

## データ

### `link_previews`（マイグレーション `0009_link_preview.sql`）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `url_hash` | TEXT PK | 正規化した URL（今の `url` 列と同じ値）の SHA-256（base64url） |
| `status` | TEXT | `pending`・`ok`・`failed` |
| `title` | TEXT | 200文字まで |
| `description` | TEXT | 300文字まで |
| `site_name` | TEXT | 100文字まで |
| `image_id` | TEXT | R2 の画像の ID（UUID）。なければ NULL |
| `image_type` | TEXT | `image/jpeg` など |
| `fetched_at` | INTEGER | 最後に取りに行った時刻 |
| `created_at` | INTEGER | |

- URL そのものは持たない（誘い・募集の `url` 列にある）。同じ URL は1行（決定事項4）。
- 掃除：Cron で、どの誘い・募集の `url` からも参照されなくなり、30日を過ぎた行を消し、R2 の画像も消す。

### R2（`OGP_IMAGES`）
- Terraform の `kokohima-<env>-ogp-images`（定義済み）を、wrangler の `r2_buckets` に `OGP_IMAGES` としてつなぐ。ローカルと e2e は Miniflare の R2。
- キーは `images/v1/<image_id>`。`httpMetadata.contentType` に種類を入れる。

## 振る舞い

### 取得のきっかけ
1. 誘い・募集の作成で、`url` があれば、同じ batch で outbox に `LinkAttached` を書く。
   - payload：`{ subjectType: "direct_invite" | "broadcast", subjectId, occurredAt }`（URL は入れない。T-04 の決まりのとおり ID だけ）。
   - 同じ batch で、`link_previews` に `INSERT OR IGNORE`（`status = 'pending'`）を書く（画面がすぐ「取得中」にできるように）。
2. consumer は `LinkAttached` を受けたら、invitation の application の関数で `url` を読み、取得の処理に渡す。
   - すでに `ok` か、24時間以内に `failed` になった行があれば、取りに行かない（同じ URL を何度送っても1回。決定事項4）。
   - 24時間を過ぎた `failed` は、次に同じ URL が送られたときに取り直す。`ok` は取り直さない（送った時点の内容を見せる）。
3. 一時的な失敗（取得先の5xx・タイムアウト・名前解決の失敗）は投げて、Queue の再試行に任せる（最大5回）。最後まで失敗したら `failed` にする（退避キューの前に、5回めの試行で書く）。
- 量の上限：取得のきっかけは誘い・募集の作成だけなので、送信上限（誘いと募集を合わせて24時間に20件。T-04・T-05）が、利用者ごとの取得の上限になる（決定事項5）。

### 取りに行ってよい URL（domain）
- スキームは `http`・`https`。ポートは指定なしか、80（http）・443（https）だけ。userinfo なし（今の `linkUrlSchema` も拒否している）。
- ホストが IP アドレスの直書き（IPv4・IPv6）なら取らない（Workers も取れない）。
- ホストが `localhost`、`.localhost`・`.local`・`.internal`・`.home.arpa`・`.test`・`.invalid`・`.example`・`.onion` で終わるもの、ドットを含まないものは取らない。
- アプリ自身のホスト（`APP_ORIGIN` のホスト）とそのサブドメインは取らない。

### 名前解決の検査（infra。決定事項2）
- 取りに行く前に、ホスト名を DNS over HTTPS（`https://cloudflare-dns.com/dns-query`、`Accept: application/dns-json`）で A・AAAA の両方を引く。
- 返ったアドレスが1つでも次に当たれば取らない（`failed`）：
  - IPv4：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.0.0.0/24`、`192.0.2.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4` 以上。
  - IPv6：`::/128`、`::1/128`、`::ffff:0:0/96`（IPv4 を埋め込んだもの。中の IPv4 で判定）、`64:ff9b::/96`、`fc00::/7`、`fe80::/10`、`ff00::/8`、`2001:db8::/32`。
- アドレスが1つもなければ取らない。名前解決そのものの失敗（DoH の5xx・タイムアウト）は一時的な失敗。
- 受け入れるリスク：名前解決の検査と実際の取得の間に DNS の答えが変わる（DNS rebinding）と、検査をすり抜けうる。Workers は Cloudflare のエッジから外に出るので、内部のアドレスに向いても届く先は利用者の側のネットワークではない。さらに `global_fetch_strictly_public` で自分のゾーンも外からの要求として扱う。そのため、検査は「明らかに内部を向く URL を取りに行かない」ための多重の防御として行う。

### 取得（infra）
- `redirect: "manual"`。3xx は `Location` を絶対の URL にして、取りに行ってよい URL か・名前解決の検査を通るかを毎回確かめる。リダイレクトは3回まで。
- タイムアウトは1回の取得ごとに5秒、ページ全体（リダイレクトを含む）で10秒。
- 要求のヘッダー：`User-Agent: kokohima-link-preview/1.0`、`Accept: text/html,application/xhtml+xml`、`Accept-Language: ja`。Cookie・Authorization・Referer は付けない。
- 応答の `Content-Type` が `text/html` か `application/xhtml+xml` でなければ `failed`。
- 本文はストリームで読み、512KB で打ち切る（`<head>` の中に OGP があれば足りる）。文字コードは `Content-Type` の `charset`、なければ `<meta charset>`、なければ UTF-8。読めない文字コードは `failed`。
- 200 以外（3xx を除く）の応答は、4xx なら `failed`、5xx・429 なら一時的な失敗。

### 解析（domain）
- `<head>` の中の `<meta property="og:title|og:description|og:site_name|og:image">`（`name` 属性も見る）、なければ `<title>`・`<meta name="description">`。
- 文字列は、HTML の文字参照を戻し、制御文字・書式文字を除き、連続する空白を1つにし、長さの上限（タイトル200・説明300・サイト名100）で切る。
- タイトルも説明もなければ `failed`。
- `og:image` は、ページの URL からの相対を絶対の URL にし、取りに行ってよい URL か確かめる（http のページの画像も可）。

### 画像（infra）
- ページと同じ検査（URL・名前解決・リダイレクト3回・タイムアウト5秒）で取る。`Accept: image/jpeg,image/png,image/webp,image/gif`。
- 2MB で打ち切り、超えたら画像なし（ページの `ok` は保つ）。
- 種類は、応答の `Content-Type` と先頭のバイト（JPEG `FF D8 FF`、PNG `89 50 4E 47`、WebP `RIFF....WEBP`、GIF `GIF87a`・`GIF89a`）の両方が一致したときだけ受け付ける。SVG・その他は画像なし。
- 受け付けた画像は、そのままのバイトを R2 の `images/v1/<image_id>` に置く（変換しない）。`image_id` は新しい UUID。
- 画像の取得の失敗は、ページの結果に影響させない（画像なしの `ok`）。

### 配信
- `GET /api/v1/link-previews/images/{imageId}`：`image_id` で `link_previews` の `status = 'ok'` の行を確かめ、R2 から読んで返す。なければ404。
- `imageUrl` は `<APIのオリジン>/api/v1/link-previews/images/<image_id>`。
- ID は URL から作らない（URL を知っている人が、その URL が誰かに送られたかを確かめられないように）。

### 画面（仮）
- 誘い・募集・予定の詳細で、`linkPreview.status = "ok"` のときカードを出す：画像（あれば）・タイトル・説明・ドメイン（`linkHostname`。T-04 と同じ punycode の表示）。カード全体を、今と同じ `target="_blank" rel="noopener noreferrer nofollow"` のリンクにする。
- `pending`・`failed`・`null` は、今と同じドメインだけのリンク。`pending` に「読み込み中」は出さない（取れなかったときと同じ見え方にする）。
- タイトル・説明はテキストとして出す（HTML として解釈しない）。ドメインは必ず `linkHostname` で出し、`siteName` で置き換えない（見た目による偽装を防ぐ）。
- 画像は `<img loading="lazy" referrerpolicy="no-referrer" alt="">`。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `OGP_IMAGES` | R2 | `kokohima-<env>-ogp-images`。wrangler の4つの環境に書く（ローカル・e2e は Miniflare の R2） |
| `global_fetch_strictly_public` | 互換性フラグ | `compatibility_flags` に足す |

### E2E用の偽のサイト
- E2E のエントリで、`ogp.e2e.invalid` あての `fetch` を偽のサイトに向ける（T-06 の `e2eFetch` に足す）。
- `.invalid` は取りに行ってよい URL ではないので、E2E のエントリだけ `AppDeps` で偽のホストを許し、名前解決の検査を公開のアドレスを返す偽物に差し替える（`createWorker(overrides)` を通して `apps/api/src/e2e/entry.ts` からだけ）。
- CI の本番ビルドの検査に、偽のホスト名を足す。

## 認可と秘匿
- 閲覧者IDの使い方：プレビューは、誘い・募集・予定の DTO の一部として、今と同じ閲覧者の条件で読む。link-preview の読み取りは、invitation が閲覧者で絞って読んだ行の `url` からだけ行う（link-preview は閲覧者の条件を持たない。T-02 の `getPublicProfiles` と同じ扱い）。
- 他人のデータに届かないことの保証：誘い・募集・予定を見られない人には、今までどおり404。プレビューの行は URL ごとで、誰が送ったかを持たない。
- 画像の経路は認証なし。推測できない UUID で、URL からは作らない。配信するのは公開のページの画像だけ。
- 区別させない応答：
  - 募集の宛先の人には、今の `url` と同じくプレビューも見える。応答者の有無には関係しない。
  - `failed` の理由（内部のアドレス・タイムアウト・HTML でない）は返さない。
- 外に渡すもの：取得先のサイトには、アプリのサーバーから要求が届く。送った人・受け取った人の情報（Cookie・トークン・名前）は渡さない。
- 受け入れるリスク：
  - 取得先のサイトは、リンクが送られたこと（とその時刻）を、アプリのサーバーからの要求で知ることができる。
  - 1回だけ使えるリンク（ログインのリンクなど）を送ると、取得の GET でそのリンクが使われることがある（ほかのチャットアプリのプレビューと同じ）。
- ログ：URL・ホスト名・タイトル・IP アドレスを出さない。出すのは結果の種類（`ok`・`failed`・一時的な失敗）と状態コードだけ。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 取りに行ってよい URL：http・https、ポート、userinfo、IP の直書き（IPv4・IPv6・`[::1]`）、`localhost`・内部向けの接尾辞・ドットなし、アプリ自身のホスト。
- [ ] IP の検査：上の範囲の境界（`172.15.255.255` は通し `172.16.0.0` は拒む、など）、`::ffff:127.0.0.1`、`fe80::1`、`fc00::1`。
- [ ] 名前解決：A・AAAA のどれか1つでも内部なら取らない。答えがなければ取らない。DoH の失敗は一時的な失敗。
- [ ] リダイレクト：3回まで追い、4回めは `failed`。リダイレクト先が内部・取りに行ってはいけない URL なら `failed`。相対の `Location`。
- [ ] 取得：タイムアウト、`Content-Type` が HTML でない、512KB で打ち切る（大きいページでも OGP が先頭にあれば取れる）、4xx は `failed`、5xx・429 は投げる、Cookie・Authorization を送らない。
- [ ] 解析：og: と name の両方、`<title>`・description の代わり、文字参照、制御文字、長さの上限、`<head>` の外の meta は読まない、タイトルも説明もなければ `failed`、文字コード（Shift_JIS など）。
- [ ] 画像：種類と先頭のバイトが合うときだけ。SVG・HTML を画像と偽ったもの・2MB 超は画像なし。画像の失敗はページの `ok` に影響しない。R2 に `images/v1/<UUID>` で置く。
- [ ] 同じ URL：2回送っても取得は1回。24時間を過ぎた `failed` は取り直す。`ok` は取り直さない。
- [ ] 再試行：5回めの失敗で `failed` になる。
- [ ] `LinkAttached`：リンクがあるときだけ、作成と同じ batch で書く。payload に URL がない。`link_previews` に `pending` の行ができる。
- [ ] DTO：誘い・募集・予定の詳細と一覧に `linkPreview`。リンクがなければ null。`failed` の項目はすべて null。
- [ ] 他人のIDでは取得できない：誘い・募集・予定を見られない人には404（プレビューも出ない）。
- [ ] 画像の経路：ある ID は画像とヘッダー（`nosniff`・CSP・CORP・Cache-Control）、ない ID・壊れた ID・`status` が `ok` でない行は404。Rate Limiting の `link_image`。
- [ ] 掃除：参照されなくなって30日を過ぎた行と R2 の画像を消す。参照されている行は消さない。
- [ ] ログ：URL・ホスト名・タイトルが出ない。
- [ ] Web：`ok` はカード（画像・タイトル・説明・ドメイン）、`pending`・`failed`・null はドメインだけ。ドメインは punycode。タイトルを HTML として解釈しない。

### E2Eテスト（対象にする利用者の流れ）
- [ ] A が B に、偽のサイトのリンク付きで誘う → outbox を処理する → B の誘いの詳細に、タイトル・説明・画像のカードが出る。
- [ ] 取れないリンク（偽のサイトが404を返す）では、ドメインだけが出る。

## スコープ外
- 作成画面での送る前のプレビュー（決定事項1）。
- 画像の変換・縮小・形式の統一。
- 取得先ごとの上限（同じサイトへの集中）。送信上限で量は抑えられる。
- oEmbed・Twitter カードなど、OGP 以外の形式。
- 送ったあとのプレビューの更新（`ok` は取り直さない）。

## 決定事項（仕様書PRのレビューで合意する）
1. 作成画面での送る前のプレビューは出さない（実装の前に利用者に確かめた）。取得は consumer だけが行う。
2. 取りに行く前に DNS over HTTPS で A・AAAA を引き、内部のアドレスなら取らない。リダイレクト先も毎回同じ検査をする。DNS rebinding は受け入れるリスクとし、多重の防御で抑える。（提案）
3. `global_fetch_strictly_public` の互換性フラグを付ける。（提案）
4. 同じ URL の結果は D1 の `link_previews` に1行で持ち、それを「同じ URL のキャッシュ」にする。`ok` は取り直さず、`failed` は24時間後に取り直す。（提案。利用者は「キャッシュは KV」と答えたが、取得の結果は保存が要件（F-15「取得・保存」）で、強い整合性のある D1 の1行で同じ URL の重複も防げるため、KV は使わない）
5. 利用者ごとの取得の上限は、送信上限（24時間に20件）で兼ねる。（提案）
6. 画像は R2 にそのまま保存し、推測できない UUID の経路から、種類と先頭のバイトが合うものだけを配信する。SVG は扱わない。（利用者は「R2 に保存して出す」と答えた。細部は提案）

## 確認事項（合意前に解消する）
- 決定事項4：KV を使わないことでよいか。
- 上限の値（ページ512KB・画像2MB・リダイレクト3回・タイムアウト5秒／10秒・掃除30日）は仮の値。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-18 | 初版 | pryusei/kokohima-app#47 |
