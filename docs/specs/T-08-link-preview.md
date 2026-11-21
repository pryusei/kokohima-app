# T-08 仕様書：リンクのプレビュー（OGP）

- 状態：実装済み
- タスク票：docs/tasks/T-08-link-preview.md
- 関係する要件：F-15、NF-02、要求定義書「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」「Link Preview：OGP取得、画像プロキシ」、セキュリティ設計「外部への取得（OGP）」。issue pryusei/kokohima-app#47

## 概要
- 誘い・募集にリンクが付いていたら、送ったあとに consumer がそのページを取り、OGP（タイトル・説明・サイト名・画像）を保存する。画像は R2 に保存し、アプリの経路から配信する。
- 詳細の画面（誘い・募集・成立した予定）に、カード（タイトル・説明・画像・ドメイン）を出す。取れるまでと、取れなかったときは、今と同じドメインだけ。
- 作成画面での送る前のプレビューはしない（決定事項1。外部への取得を consumer の1か所にまとめるため）。

## 前提

### コンテキストの分担
- 新しいコンテキスト `link-preview`（`apps/api/src/link-preview/{domain,application,infra}`）。
  - domain（純粋）：URL の検査（取りに行ってよいか）、IP アドレスの検査、HTML からの OGP の取り出し、文字列の整え方、画像の種類と大きさの判定（先頭のバイト）。
  - infra：取得（`AppDeps.fetch`）、名前解決（DNS over HTTPS）、D1、R2。
  - application：イベントから取得して保存する処理、画像の配信、invitation から呼ぶ読み取り（`previewsFor(subjects)`）。
- invitation は、誘い・募集の作成の batch に、outbox の `LinkAttached` を書く（outbox は全コンテキストが書く表。link-preview の表には触らない）。応答の DTO には、link-preview の application の `previewsFor` で読んだプレビューを足す（invitation は link-preview の表を直接読まない）。

### 公式で確かめたこと（2026-11-18）
- Workers の `fetch` は、IP アドレスあての URL を直接は取れない（URL のホスト名で取る）。
- `global_fetch_strictly_public` の互換性フラグがないと、自分のゾーンあての `fetch` は、Cloudflare のセキュリティ設定を飛ばしてオリジンに届く。このフラグには既定で有効になる日付がないので、wrangler の `compatibility_flags` に明示して付ける（決定事項3）。ほかの外部呼び出し（Google・Resend・プッシュ）は公開のホストなので影響しない。
- `redirect` は `follow` か `manual`。`manual` にして、リダイレクトを自分で数えて検査する。
- Workers は応答の大きさを制限しない。圧縮された応答は自動で展開されるので、読む量は展開後の量で自分で打ち切る。
- `TextDecoder` の対応する文字コードは、公式の資料（Encoding API）に一覧がない（`TextDecoder` は UTF-8 のデコーダーとだけ書かれている）。互換性フラグの一覧に `text_decoder_cjk_decoder`（CJK の文字コードの専用の実装。2026-03-03 から既定で有効）がある。このリポジトリの `compatibility_date`（2026-08-22）のローカルの workerd（`pnpm test`）で、`shift_jis`・`euc-jp`・`iso-2022-jp`・`windows-31j`（→`shift_jis`）が読めること、知らない名前は `RangeError` になることを確かめた（2026-11-21）。実装PRの単体テストで、この3つを読めることを確かめ続ける。
- R2 の書き込み・削除は強い整合性。`put` にストリームを渡すときは長さが要るので、読み終えた `ArrayBuffer` を渡す。
- 1回の呼び出しの外部の取得（サブリクエスト）は、有料プランで10,000まで。1件の処理は、名前解決（A・AAAA）とリダイレクトを入れて、ページと画像で最大24回ほどに収まる。

### 実装PRで直したもの
- T-04・T-05 の仕様書の画面の節：「ドメインだけ（OGP は T-08）」をカードの表示に直す。
- 要求定義書：イベントの表に `LinkAttached`、「OGP取得：ユーザーごとのレート制限、同一URLはキャッシュ」に決定事項4・5、残りの論点（レート制限の値）に `link_image`。
- invitation-domain スキル：イベントの表に `LinkAttached`、用語表に「リンクのプレビュー」→`LinkPreview`。
- `apps/api/src/jobs/consumer.ts` の `MAX_ATTEMPTS` を `MAX_RETRIES` に改める（値は wrangler の `max_retries` と同じ5。試行の回数ではなく再試行の回数なので、名前を意味に合わせる）。この仕様書では `MAX_RETRIES` と書く。
- `apps/api/src/http/rateLimit.ts` の `RateLimitGroup` に `link_image`、.github/workflows/ci.yml の本番ビルドの検査に偽のホスト名と E2E の名前。

## API
`api-conventions` スキルに従う。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/link-previews/images/{imageId}` | なし（推測できない ID。`<img>` で読むため） | path：`imageId`（UUID） | 200：画像（`image/jpeg`・`image/png`・`image/webp`・`image/gif`） | 404（ない・壊れた ID）、429（本文なし） |

- 既存の経路の応答に、`linkPreview` を足す（`packages/shared` の `linkPreviewSchema`）。
  - `GET /direct-invites/{id}`・一覧、`GET /broadcasts/{id}`・一覧、`GET /meetups/{id}`・一覧、作成・状態遷移の応答（同じ DTO）。
  - 形：`{ status: "pending" | "ok" | "failed", title: string | null, description: string | null, siteName: string | null, imageUrl: string | null }`。リンクがなければ `linkPreview: null`。
  - その誘い・募集の参照の行（`link_preview_refs`）がなければ `pending`（まだ処理していない）。参照の先が `ok` なら `ok`、`failed` なら `failed`。`pending`・`failed` のときは、項目はすべて null（理由は返さない）。
  - T-08 より前に作られた誘い・募集のリンクは、参照の行がないので `pending` のまま（取り直さない。見え方は `failed` と同じドメインだけ）。
  - 見える人は、今の `url` と同じ（誘い・募集・予定を見られる人だけ）。他人の ID では、今までどおり404。
- 画像の経路の応答のヘッダー：`Content-Type`（保存した種類）、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`、`Cache-Control: public, max-age=86400, immutable`、`Cross-Origin-Resource-Policy: same-origin`、`Content-Disposition: inline`。
- 画像の経路には、Rate Limiting の `RL_PUBLIC`（IP。まとまりの名前 `link_image`）を付ける。超えたら本文なしの429（`Retry-After: 60`）。T-10 の「回数の上限を付ける経路」の表にも足す。
- `imageUrl` は相対のパス `/api/v1/link-previews/images/<image_id>`（API は `APP_ORIGIN` と同じオリジン）。

## データ（マイグレーション `0009_link_preview.sql`）

### `link_previews`（取得の結果。URL ごとに、取得のたびに1行）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `url_hash` | TEXT | 正規化した URL（今の `url` 列と同じ値。フラグメント `#...` を除く）の SHA-256（base64url） |
| `status` | TEXT | `fetching`・`ok`・`failed` |
| `title` | TEXT | 200文字まで |
| `description` | TEXT | 300文字まで |
| `site_name` | TEXT | 100文字まで |
| `image_id` | TEXT | R2 の画像の ID（UUID）。なければ NULL。UNIQUE |
| `image_type` | TEXT | `image/jpeg` など |
| `claimed_at` | INTEGER | 取得の権利を取った時刻 |
| `fetched_at` | INTEGER | 取得を終えた時刻（`ok`・`failed`） |

- インデックス：`(url_hash, fetched_at)`。`url_hash` に対して `status = 'fetching'` の行は1つだけ（部分の UNIQUE インデックス `WHERE status = 'fetching'`）。
- URL そのものは持たない（誘い・募集の `url` 列にある）。

### `link_preview_images`（R2 に置いた画像の台帳）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `image_id` | TEXT PK | R2 の画像の ID（UUID） |
| `created_at` | INTEGER | R2 に置く前に、この行を書いた時刻 |

- R2 に画像を置く前に、この行を書く。R2 の画像を消すのは、この台帳から判定する掃除だけ（R2 の `list` は使わない。キーの順にしか読めず、置いた時刻で絞れないため）。

### `link_preview_refs`（誘い・募集がどの結果を見せるか）
| 列 | 型 | 内容 |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `direct_invite_id` | TEXT | → `direct_invites.id`（`ON DELETE CASCADE`）。NULL 可。UNIQUE |
| `broadcast_id` | TEXT | → `broadcasts.id`（`ON DELETE CASCADE`）。NULL 可。UNIQUE |
| `preview_id` | TEXT | → `link_previews.id` |
| `created_at` | INTEGER | |

- `CHECK ((direct_invite_id IS NULL) <> (broadcast_id IS NULL))`（どちらか一方だけ）。`preview_id` のインデックス。
- 誘い・募集ごとに外部キーの列を分け、誘い・募集が消えたとき（利用者の削除の CASCADE。T-04・T-05）に参照の行も一緒に消えるようにする。種類と ID の組で持つと、誘い・募集が消えても参照の行が残り、結果の行がずっと「参照あり」になって掃除されないため。
- 成立した予定は、元の誘い・募集の参照を使う（予定は自分の `url` を持たず、元の誘い・募集の `url` を返す。T-04・T-05）。

### 掃除（毎分の `cleanupExpired`）
- 結果の行：どの `link_preview_refs` からも参照されていない `link_previews` の行のうち、次のどちらかに当たるものを消す。
  - `ok`・`failed` で、`fetched_at` から30日を過ぎたもの。
  - `fetching` のまま、`claimed_at` から1時間を過ぎたもの（処理が途中で終わり、同じ URL が送られず引き継がれなかった行。`fetched_at` が NULL なので、上の条件では消えない）。
- 画像：`link_preview_images` のうち、`created_at` から1時間を過ぎ、`link_previews.image_id` から参照されていないものについて、R2 の `images/v1/<image_id>` を消してから台帳の行を消す（R2 の削除に失敗したら台帳の行を残し、次の回でやり直す）。
  - 結果の行を消したときの画像も、この掃除で消える（画像を消す道は1つだけ）。
  - 1時間の猶予は、R2 に置いてから `link_previews.image_id` を書くまでの間に、置いたばかりの画像を消さないため。
- 1回の掃除で扱う行の数は、結果の行・画像それぞれ100まで（`CLEANUP_LIMIT`）。
- `fetching` のまま10分を過ぎた行は、取得の権利を引き継げる（下の手順）。

### R2（`OGP_IMAGES`）
- Terraform の `kokohima-<env>-ogp-images`（定義済み）を、wrangler の `r2_buckets` に `OGP_IMAGES` としてつなぐ。wrangler の4つの環境（ローカル・e2e・staging・prod）に書く（ローカル・e2e は Miniflare の R2）。
- キーは `images/v1/<image_id>`。`httpMetadata.contentType` に種類を入れる。

## 振る舞い

### 取得のきっかけ
1. 誘い・募集の作成で、`url` があれば、同じ batch で outbox に `LinkAttached` を書く。
   - 既存の outbox の行と同じく、`WHERE EXISTS (SELECT 1 FROM direct_invites（または broadcasts） WHERE id = ?)` の条件付き。送信が拒否された（友達でない・同じ誘いがある・送信上限）ときは、`LinkAttached` も書かない。
   - payload：`{ subjectType: "direct_invite" | "broadcast", subjectId, occurredAt }`（URL は入れない。T-04 の決まりのとおり ID だけ）。
2. `LinkAttached` は、dispatch の「常に流す型」（今の `CALENDAR_TYPES` の側。`NOTIFICATION_START_AT` に左右されない）に足す。
3. consumer は `LinkAttached` を受けたら、すでにその誘い・募集の参照の行があれば何もしない。なければ、invitation の application の関数（閲覧者で絞らない consumer 用。`calendarFacing.ts` と同じ扱い）で `url` を読み、次の手順で結果を決めて、参照の行を書く。
   - 誘い・募集がすでにない（利用者の削除で消えた）なら、何もせずに終える（投げない）。参照の行は `INSERT OR IGNORE ... SELECT ... WHERE EXISTS (SELECT 1 FROM direct_invites（または broadcasts） WHERE id = ?)` で書き、処理の間に消えていたら書かずに終える。
   - 使い回せる結果：同じ `url_hash` の、7日以内に `ok` になった行、または24時間以内に `failed` になった行（いちばん新しいもの）。あれば、それを参照する（取りに行かない。決定事項4）。
   - なければ、取得の権利を取る：`status = 'fetching'` の新しい行を入れる（部分の UNIQUE インデックスで、同じ URL を同時に取りに行くのは1つだけ）。入らなければ（ほかの処理が取得中）、一時的な失敗として投げ、Queue の再試行で後から参照する。10分を過ぎた `fetching` の行は、`WHERE id = ? AND status = 'fetching' AND claimed_at < ?` の条件付き UPDATE で `claimed_at` を進めて引き継ぐ。
   - 取得を終えたら、`WHERE id = ? AND status = 'fetching'` の条件付き UPDATE で `ok`・`failed` と項目を書き、参照の行を書く。
   - この UPDATE が0行だったら（権利を引き継いだ側が先に終えた、または掃除で行が消えた）、その行を読み直す。
     - `ok`・`failed` になっていれば、その行を参照して終える（自分の結果は書かない）。自分が R2 に置いた画像は、台帳の掃除で消える。
     - 行がない、またはまだ `fetching` なら、一時的な失敗として投げる（次の試行で、使い回すか権利を取り直す）。
4. 一時的な失敗（取得先の5xx・429・タイムアウト・名前解決の失敗・ほかの処理が取得中・取得の途中の思わぬ例外）は投げて、Queue の再試行に任せる。
   - 権利を取った処理が一時的な失敗で投げるときは、投げる前に権利を手放す：`DELETE FROM link_previews WHERE id = ? AND status = 'fetching' AND claimed_at = ?`（自分が取った時刻。引き継がれていたら消さない）。手放さないと、同じメッセージの再試行が自分の権利に阻まれ、10分を過ぎるまで（今の再試行の間隔では6回めまで）取りに行けないため。手放すのに失敗しても、10分の引き継ぎで救われる。
   - consumer は `handleJob` にメッセージの試行の回数（`message.attempts`）を渡す。最後の試行（`attempts > MAX_RETRIES`。`message.attempts` は1から数えるので、最初の1回と再試行5回で6回め）でも失敗したら、`failed` の行を書いて参照し、投げずに終える（退避キューに送らない）。権利を持っていれば、その行を条件付き UPDATE で `failed` にする（新しい行は入れない）。
   - E2E の drain など試行の回数がない呼び出しは、最後の試行として扱わない。
- 量の上限：取得のきっかけは誘い・募集の作成だけなので、送信上限（誘いと募集を合わせて24時間に20件。T-04・T-05）が、利用者ごとの取得の上限になる（決定事項5）。
- 見え方：誘い・募集を作った直後は、使い回せる結果があってもなくても、consumer が処理するまで `pending`。処理（毎分の dispatch のあと）で `ok`・`failed` になる。使い回したときと新しく取ったときの差は、取得の数秒だけ（受け入れるリスク）。

### 取りに行ってよい URL（domain）
- WHATWG URL で解析した後の値で判定する（`127.1`・`0x7f000001`・全角の文字などは、解析で正規化されてから判定される）。
- スキームは `http`・`https`。ポートは指定なしか、80（http）・443（https）だけ。userinfo なし。
- ホスト名の末尾の `.` は1つ除いてから判定する。除いたあとに空のラベルが残るもの（`x.workers.dev..` など）は取らない。
- ホストが IP アドレス（IPv4・IPv6）なら取らない。
- ホストが `localhost`、`.localhost`・`.local`・`.internal`・`.home.arpa`・`.test`・`.invalid`・`.example`・`.onion` で終わるもの、ドットを含まないものは取らない。
- アプリ自身のドメイン（設定値 `LINK_PREVIEW_OWN_DOMAINS` に書いたもの）とそのサブドメイン、`workers.dev` とそのサブドメインは取らない。
  - 登録ドメイン（`APP_ORIGIN` のホストから求める）には Public Suffix List が要るので、コードでは求めない。登録ドメインを人が設定値に書き、domain の判定の関数には引数で渡す（domain は設定を読まない）。
  - `LINK_PREVIEW_OWN_DOMAINS` はカンマ区切りの小文字のホスト名。`.invalid`・`.example` で終わる値は置き換え忘れのプレースホルダーとみなして読めない値にする。空・読めない値なら、取りに行かずに一時的な失敗として投げる（設定の誤りで自分のドメインに向かないように。最後の試行では `failed`）。

### 名前解決の検査（infra。決定事項2）
- 取りに行く前に、ホスト名を DNS over HTTPS（`https://cloudflare-dns.com/dns-query`、`Accept: application/dns-json`）で A・AAAA の両方を引く。1回のタイムアウトは3秒。
- `Status` が 3（NXDOMAIN）なら `failed`、2（SERVFAIL）・ほかの失敗・タイムアウトは一時的な失敗。
- `Answer` のうち type 1（A）と 28（AAAA）の `data` だけをアドレスとして使う（CNAME などは使わない）。アドレスとして読めない値があれば取らない（fail closed）。アドレスが1つもなければ取らない。
- 返ったアドレスが1つでも次に当たれば取らない（`failed`）：
  - IPv4（拒否の一覧）：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`、`127.0.0.0/8`、`169.254.0.0/16`、`172.16.0.0/12`、`192.0.0.0/24`、`192.0.2.0/24`、`192.88.99.0/24`、`192.168.0.0/16`、`198.18.0.0/15`、`198.51.100.0/24`、`203.0.113.0/24`、`224.0.0.0/4`、`240.0.0.0/4`、`255.255.255.255/32`。
  - IPv6（許可の一覧）：`2000::/3` の中だけを通す。その中でも `2001::/32`（Teredo）、`2001:db8::/32`・`3fff::/20`（どちらも文書用。後者は RFC 9637）、`2002::/16`（6to4）は取らない。`::ffff:0:0/96`・`::/96`・`64:ff9b::/96`・`64:ff9b:1::/48`・`100::/64`・`fc00::/7`・`fe80::/10`・`fec0::/10`・`ff00::/8` などは `2000::/3` の外なので取らない。
- 受け入れるリスク：名前解決の検査と実際の取得の間に DNS の答えが変わる（DNS rebinding）と、検査をすり抜けうる。Workers は Cloudflare のエッジから外に出るので、内部のアドレスに向いても届く先は利用者の側のネットワークではない。さらに `global_fetch_strictly_public` で自分のゾーンも外からの要求として扱う。検査は「明らかに内部を向く URL を取りに行かない」ための多重の防御として行う。
- `apps/api/src/http/rateLimit.ts` の `clientKeyOf`（読めない値で上限をかけない作り）は流用しない。

### 取得（infra）
- `redirect: "manual"`。3xx は `Location` を絶対の URL にして（`Location` がない・解析できなければ `failed`）、取りに行ってよい URL か・名前解決の検査を通るかを毎回確かめる。リダイレクトは3回まで。
- タイムアウトは、1回の取得ごとに本文を読み終えるまでで5秒、ページ全体（名前解決とリダイレクトを含む）で10秒。画像も同じ（画像全体で10秒）。
- 要求のヘッダー：`User-Agent: kokohima-link-preview/1.0`、`Accept: text/html,application/xhtml+xml`、`Accept-Language: ja`。Cookie・Authorization・Referer は付けない。
- 応答の `Content-Type` が `text/html` か `application/xhtml+xml` でなければ `failed`。
- 本文はストリームで読み、展開後の量で512KB に達したら `reader.cancel()` で止める（`<head>` の中に OGP があれば足りる）。文字コードは `Content-Type` の `charset`、なければ `<meta charset>`、なければ UTF-8。`TextDecoder` が扱えない文字コードは `failed`。
- 200 以外（3xx を除く）の応答は、4xx（429 を除く）なら `failed`、5xx・429 なら一時的な失敗。

### 解析（domain）
- コメントと script・style の中身は読まない（閉じがなければ残りを捨てる）。`<head>` の終わり（`</head>`・`<body`）は、それらを除いたあとで判定する。タグの読み取りは左から1回の走査で行い、閉じのないタグが多数あっても、ページの大きさに比例する時間で終える。
- `<head>` の中の `<meta property="og:title|og:description|og:site_name|og:image">`（`name` 属性も見る）、なければ `<title>`・`<meta name="description">`。
- 文字列は、HTML の文字参照を戻し、制御文字・書式文字を除き、連続する空白を1つにし、長さの上限（タイトル200・説明300・サイト名100）で切る。
- タイトルも説明もなければ `failed`。
- `og:image` は、リダイレクトを追ったあとのページの URL からの相対を絶対の URL にし、取りに行ってよい URL か確かめる（http のページの画像も可）。

### 画像（infra）
- ページと同じ検査（URL・名前解決・リダイレクト3回・タイムアウト）で取る。`Accept: image/jpeg,image/png,image/webp,image/gif`。
- 展開後の量で2MB に達したら止めて、画像なしにする（ページの `ok` は保つ）。
- 種類は、応答の `Content-Type` と先頭のバイト（JPEG `FF D8 FF`、PNG `89 50 4E 47`、WebP `RIFF....WEBP`、GIF `GIF87a`・`GIF89a`）の両方が一致したときだけ受け付ける。SVG・その他は画像なし。
- 大きさ：ヘッダー（PNG の IHDR、GIF の論理画面、JPEG の SOF、WebP の VP8・VP8L・VP8X）から幅と高さを読み、どちらかが4096を超える、または読めないものは画像なし（受け取った人の端末で表示が固まるのを防ぐ）。
- 受け付けた画像は、そのままのバイトを R2 の `images/v1/<image_id>` に置く（変換しない）。`image_id` は新しい UUID。置く前に `link_preview_images` に台帳の行を書き、置いたあとで、取得を終える条件付き UPDATE で `link_previews.image_id` を書く。
- 画像の取得の失敗は、ページの結果に影響させない（画像なしの `ok`）。取得の権利を引き継がれたときや、処理が途中で終わったときに R2 に残った、参照されない画像は、台帳から掃除で消す（「掃除」）。

### 配信
- `GET /api/v1/link-previews/images/{imageId}`：`image_id` で `link_previews` の `status = 'ok'` の行を確かめ、R2 から読んで返す。なければ404。
- ID は URL から作らない（URL を知っている人が、その URL が誰かに送られたかを確かめられないように）。

### 画面（仮）
- 最終的な見た目と画面のつながりは T-11（docs/specs/T-11-design.md）で置き換えた。下の記述は機能の決まりとして残し、置き場所が変わったものは注記する。
- 誘い・募集・予定の詳細で、`linkPreview.status = "ok"` のときカードを出す：画像（あれば）・タイトル・説明・ドメイン（`linkHostname`。T-04 と同じ punycode の表示）。カード全体を、今と同じ `target="_blank" rel="noopener noreferrer nofollow"` のリンクにする。
- `pending`・`failed`・null は、今と同じドメインだけのリンク。`pending` に「読み込み中」は出さない（取れなかったときと同じ見え方にする）。
- タイトル・説明はテキストとして出す（HTML として解釈しない）。ドメインは必ず `linkHostname` で出し、`siteName` で置き換えない（見た目による偽装を防ぐ）。
- 画像は `<img loading="lazy" referrerpolicy="no-referrer" alt="">`。

### 設定値（Workers）
| 名前 | 種類 | 内容 |
| --- | --- | --- |
| `OGP_IMAGES` | R2 | `kokohima-<env>-ogp-images`。wrangler の4つの環境に書く |
| `LINK_PREVIEW_OWN_DOMAINS` | 変数（秘密ではない） | アプリ自身の登録ドメイン（カンマ区切り）。wrangler の4つの環境に書く（ローカル・e2e は `localhost`、staging・prod は本番のドメインが決まるまで `example.invalid`）。 |
| `global_fetch_strictly_public` | 互換性フラグ | `compatibility_flags` に足す（最上位に書けば各環境に引き継がれる） |

### E2E用の偽のサイト
- E2E のエントリで、`ogp.e2e.invalid` あての `fetch` を偽のサイトに向ける（T-06 の `e2eFetch` に足す）。偽のサイトは `/page`（OGP と画像あり）・`/og.png`・それ以外は404。
- E2E の outbox の drain（`/__e2e__/outbox/drain`）は、並んで走るテストが同じ行を同時に処理して一時的な失敗になったとき、その行を処理済みにせずに残し、同じ回の中でもう一度試す（Queue の再試行の代わり）。一時的な失敗でない例外は、今までどおりそのまま返す。
- `.invalid` は取りに行ってよい URL ではないので、E2E のエントリだけ `AppDeps.linkPreview` の `extraHosts` で偽のホストを許し、`resolve` で名前解決の検査を公開のアドレスを返す偽物に差し替える。タイムアウト（`timeouts`）も `AppDeps.linkPreview` に持ち、単体テストでだけ短くする（`createWorker(overrides)` を通して `apps/api/src/e2e/entry.ts` からだけ。T-07 の `extraPushHosts` と同じ）。既定の `AppDeps` では許さない。
- CI の本番ビルドの検査に、偽のホスト名と E2E の名前を足す。

## 認可と秘匿
- 閲覧者IDの使い方：プレビューは、誘い・募集・予定の DTO の一部として、今と同じ閲覧者の条件で読む。link-preview の `previewsFor` は、invitation が閲覧者で絞って読んだ誘い・募集の ID からだけ呼ぶ（link-preview は閲覧者の条件を持たない。T-02 の `getPublicProfiles` と同じ扱い）。
- 他人のデータに届かないことの保証：誘い・募集・予定を見られない人には、今までどおり404。取得の結果は URL ごとで、誰が送ったかを持たない。
- どの URL が送られたかを確かめられないこと：誘い・募集ごとの参照の行で見せるので、作った直後は使い回せる結果があっても `pending`（取得の結果を共有していることは、作成の応答や直後の詳細からはわからない）。
- 画像の経路は認証なし。推測できない UUID で、URL からは作らない。配信するのは公開のページの画像だけ。
- 区別させない応答：
  - 募集の宛先の人には、今の `url` と同じくプレビューも見える。応答者の有無には関係しない。
  - `failed` の理由（内部のアドレス・タイムアウト・HTML でない）は返さない。
- 外に渡すもの：取得先のサイトには、アプリのサーバーから要求が届く。送った人・受け取った人の情報（Cookie・トークン・名前）は渡さない。
- 受け入れるリスク：
  - 取得先のサイトは、リンクが送られたこと（とその時刻）を、アプリのサーバーからの要求で知ることができる。
  - 1回だけ使えるリンク（ログインのリンクなど）を送ると、取得の GET でそのリンクが使われることがある（ほかのチャットアプリのプレビューと同じ）。
  - 使い回したときと新しく取ったときで、`pending` から変わるまでの時間が数秒違う。
  - 取得先のサイトが、取得用の User-Agent にだけ別の内容を返すことは防げない（プレビュー一般の性質）。
- ログ：URL・ホスト名・タイトル・IP アドレスを出さない。出すのは結果の種類（`ok`・`failed`・一時的な失敗）と状態コードだけ。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 取りに行ってよい URL：http・https、ポート、userinfo、IP（IPv4・IPv6・`[::1]`・`127.1`・`0x7f000001`）、`localhost`・内部向けの接尾辞・末尾のドット（`localhost.`・`foo.local.`）・ドットなし・全角、`LINK_PREVIEW_OWN_DOMAINS` のドメインとそのサブドメイン（`evil-example.com` のように末尾が似ているだけのものは通す）、`workers.dev`。`LINK_PREVIEW_OWN_DOMAINS` が空・読めないときは投げる。
- [x] IP の検査：IPv4 の範囲の境界（`172.15.255.255` は通し `172.16.0.0` は拒む、`240.0.0.1`・`255.255.255.255`）、IPv6 は `2000::/3` だけ（`::ffff:7f00:1`・`0:0:0:0:0:ffff:127.0.0.1`・`::127.0.0.1`・`2002:7f00:1::`・`2001::1`・`2001:db8::1`・`3fff::1`・`fec0::1`・`fe80::1`・`fc00::1` は拒む）、読めない値は拒む。
- [x] 名前解決：A・AAAA のどれか1つでも内部なら取らない。答えがなければ取らない。CNAME の `data` を使わない。NXDOMAIN は `failed`、SERVFAIL・DoH の失敗は一時的な失敗。
- [x] リダイレクト：3回まで追い、4回めは `failed`。リダイレクト先が内部・取りに行ってはいけない URL なら `failed`。相対の `Location`。
- [x] 取得：本文を読み終えるまでの5秒・全体の10秒、`Content-Type` が HTML でない、展開後の512KB で止める（大きいページでも OGP が先頭にあれば取れる）、4xx は `failed`、5xx・429 は投げる、Cookie・Authorization・Referer を送らない。
- [x] 権利を引き継がれた側：終えるときの UPDATE が0行なら、`ok`・`failed` の行を参照して終える。行がない・まだ `fetching` なら投げる。
- [x] 文字コード：`shift_jis`・`euc-jp`・`iso-2022-jp` のページの OGP を読める。知らない文字コードは `failed`。
- [x] 解析：og: と name の両方、`<title>`・description の代わり、文字参照、制御文字、長さの上限、`<head>` の外の meta は読まない、タイトルも説明もなければ `failed`、文字コード（Shift_JIS など）。
- [x] 画像：種類と先頭のバイトが合うときだけ。SVG・HTML を画像と偽ったもの・2MB 超・幅か高さが4096超は画像なし。画像の失敗はページの `ok` に影響しない。R2 に `images/v1/<UUID>` で置く。
- [x] `LinkAttached`：リンクがあるときだけ、作成と同じ batch で書く。送信が拒否された（友達でない・同じ誘い・送信上限）ときは書かない。payload に URL がない。`NOTIFICATION_START_AT` が空でも dispatch で流れる。
- [x] 同じ URL：2回送っても取得は1回（2つめは使い回す）。同時に2つ処理しても取得は1回（2つめは一時的な失敗のあと使い回す）。10分を過ぎた `fetching` は引き継ぐ。24時間を過ぎた `failed`、7日を過ぎた `ok` は取り直す。
- [x] 権利を手放す：権利を取った処理が一時的な失敗（5xx）で投げると `fetching` の行が消え、同じメッセージの次の試行で取りに行ける。引き継がれた後は、元の処理が手放しても引き継いだ側の行を消さない。最後の試行では権利の行が `failed` になる。
- [x] 誘い・募集が消えた：`LinkAttached` の処理の前・途中で誘い・募集が消えていたら、参照の行を書かずに投げずに終える。利用者を削除すると、参照の行も CASCADE で消える。
- [x] 見え方：すでに `ok` の URL で新しく誘いを作っても、consumer の処理までは `pending`。T-08 より前の誘い（参照の行がない）は `pending`。
- [x] 再試行：最後の試行（`attempts > MAX_RETRIES`。6回め）の失敗で `failed` にして、退避キューに送らない。試行の回数がない呼び出しでは `failed` にしない。
- [x] DTO：誘い・募集・予定の詳細と一覧に `linkPreview`。リンクがなければ null。`pending`・`failed` の項目はすべて null。予定は元の誘い・募集の参照を使う。
- [x] 他人のIDでは取得できない：誘い・募集・予定を見られない人には404（プレビューも出ない）。
- [x] 画像の経路：ある ID は画像とヘッダー（`Content-Type`・`nosniff`・CSP・CORP・`Cache-Control`・`Content-Disposition`）、ない ID・壊れた ID・`status` が `ok` でない行は404。Rate Limiting の `link_image` と429・`Retry-After: 60`。
- [x] 掃除：参照されず30日を過ぎた `ok`・`failed` の行を消す。参照されず `claimed_at` から1時間を過ぎた `fetching` の行を消す。参照されている行・1時間以内の `fetching` は消さない。台帳のうち1時間を過ぎて参照されない画像は R2 から消し、1時間以内の画像（置いた直後で `image_id` がまだ書かれていない）は消さない。R2 の削除に失敗したら台帳の行を残す。利用者の削除で参照がなくなった結果の行も、30日後に消える。
- [x] 既定の `AppDeps` では偽のホストを許さず、名前解決の検査も本物を使う。
- [x] ログ：URL・ホスト名・タイトルが出ない。
- [x] Web：`ok` はカード（画像・タイトル・説明・ドメイン）、`pending`・`failed`・null はドメインだけ。ドメインは punycode。タイトルを HTML として解釈しない。

### E2Eテスト（対象にする利用者の流れ）
- [x] A が B に、偽のサイトのリンク付きで誘う → outbox を処理する → B の誘いの詳細に、タイトル・説明・画像のカードが出る。
- [x] A が偽のサイトのリンク付きで募集する → outbox を処理する → 宛先の詳細にカードが出る。
- [x] 取れないリンク（偽のサイトが404を返す）では、ドメインだけが出る。

## スコープ外
- 作成画面での送る前のプレビュー（決定事項1）。
- 画像の変換・縮小・形式の統一。
- 取得先ごとの上限（同じサイトへの集中）。送信上限で量は抑えられる。
- oEmbed・Twitter カードなど、OGP 以外の形式。
- T-08 より前に作られた誘い・募集のリンクの取得。

## 決定事項（仕様書PR pryusei/kokohima-app#75 のマージで合意）
1. 作成画面での送る前のプレビューは出さない（実装の前に利用者に確かめた）。取得は consumer だけが行う。
2. 取りに行く前に DNS over HTTPS で A・AAAA を引き、IPv4 は拒否の一覧、IPv6 は `2000::/3` の許可の一覧で判定する。リダイレクト先も毎回同じ検査をする。DNS rebinding は受け入れるリスクとし、多重の防御で抑える。
3. `global_fetch_strictly_public` の互換性フラグを付ける。
4. 同じ URL の結果は D1 の `link_previews` に持ち、それを「同じ URL のキャッシュ」にする（`ok` は7日、`failed` は24時間使い回す）。見せるのは誘い・募集ごとの参照の行で、作った直後は `pending`。利用者は「キャッシュは KV」と答えていたが、取得の結果は保存が要件（F-15「取得・保存」）で、同じ URL を同時に取りに行かないことには強い整合性が要るため、D1 の行で兼ね、KV は使わない（T-10 の仕様書の該当の3か所は実装PRで直した）
5. 利用者ごとの取得の上限は、送信上限（24時間に20件）で兼ねる。
6. 画像は R2 にそのまま保存し、推測できない UUID の経路から、種類と先頭のバイトと大きさが合うものだけを配信する。SVG は扱わない。（利用者は「R2 に保存して出す」と答えた）

## 確認事項（解消済み）
- 決定事項4（KV を使わない）と上限の値（ページ512KB・画像2MB・画像4096×4096・リダイレクト3回・タイムアウト5秒／10秒・使い回し7日／24時間・掃除30日）は、仕様書PRのマージで合意した。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-18 | 初版 | pryusei/kokohima-app#47 |
| 2026-11-18 | 誘い・募集ごとの参照の行（作った直後は `pending`）、`LinkAttached` を条件付きで書き常に流す型にする、取得の権利を条件付きで取る、最後の試行の扱い、IPv6 を許可の一覧に、URL の判定（末尾のドット・登録ドメイン・`workers.dev`）、本文を読み終えるまでのタイムアウトと展開後の量、画像の大きさ、画像の ID の一意、相対の `imageUrl`、実装PRで直すものを足した | 仕様書PRのレビュー（セキュリティ・仕様） |
| 2026-11-21 | 一時的な失敗では取得の権利を手放す。`fetching` のまま残った行を掃除する。R2 の画像を台帳（`link_preview_images`）で管理し、置いた直後の画像を消さない。参照の行を誘い・募集ごとの外部キー（CASCADE）にした | 仕様書PRのレビュー（pryusei/kokohima-app#75） |
| 2026-11-21 | Workers の `TextDecoder` の文字コードを確かめた結果を足した。自分のドメインを設定値 `LINK_PREVIEW_OWN_DOMAINS` で渡す。権利を引き継がれた側が終えるときの振る舞いを足した | 仕様書PRのレビュー（pryusei/kokohima-app#75） |
| 2026-11-21 | IPv6 の拒否に `3fff::/20`（文書用）を足した。`MAX_ATTEMPTS` を、意味に合わせて `MAX_RETRIES` に改めることにした（実装PRで直すもの） | 仕様書PRのレビュー（pryusei/kokohima-app#75） |
| 2026-11-21 | 「実装PRで直すもの」から docs/design/claude-design-prompts.md を外した（デザインのプロンプトの更新で先に直したため） | pryusei/kokohima-app#51 |
| 2026-11-21 | 実装した。決定事項と確認事項を合意済みにし、掃除の上限（100）、E2E の偽のサイトの経路と drain の再試行、`AppDeps.linkPreview` のタイムアウトを書いた | 実装PR |
| 2026-11-21 | 実装PRのレビューを反映：空のラベルの残るホスト名を拒む、`LINK_PREVIEW_OWN_DOMAINS` のプレースホルダーは読めない値、解析できない `Location` は `failed`、取得の途中の思わぬ例外は一時的な失敗、相対の `og:image` はリダイレクトのあとの URL から、コメントと script・style を読まない左から1回の走査、E2E の drain は一時的な失敗だけを残して再び試す | 実装PRのレビュー（セキュリティ・仕様） |
| 2026-11-21 | 画面の最終デザイン（T-11）に合わせ、画面の節に注記を足し、置き場所が変わった画面（お知らせ・設定・ログアウト・プリセット・招待リンクの発行など）を直した | T-11 実装PR |
