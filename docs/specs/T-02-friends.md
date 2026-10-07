# T-02 仕様書：友達と招待リンク

- 状態：実装済み
- タスク票：docs/tasks/T-02-friends.md
- 関係する要件：F-07、F-08、F-09、要求定義書「受容したリスク」「残りの論点」（招待リンクのデフォルト値・トークン設計）

## 概要
招待リンクを開いてログインした人と発行者が、その場で友達になる。友達は静かに解除でき、友達ごとに「自分の暇を見せる」を切り替えられる。
友達関係と公開設定は、以降のここ暇・誘いのAPIが「閲覧者に見せてよいか」をSQLで判定するための土台になる。

## 前提
- コンテキスト：友達関係と招待リンクは `social`（`apps/api/src/social/`）、公開設定は `availability`（`apps/api/src/availability/`）に置く。公開設定の保存と切り替えのAPIは今回作り、ここ暇への適用はT-03で行う
  - `/friends` のルートと application 層（一覧の組み立て、`PATCH` の流れ）は `social` が持つ
  - `sharing_policies` の読み書きは `availability` の application 層の関数（`getSharingFor(ownerId, targetIds)`、`setSharing(ownerId, targetId, visible)`）だけが行う。`social` は表を直接読まず、これらの関数を呼ぶ
  - 友達かどうかの確認は `social` が先に行い、友達のときだけ `setSharing` を呼ぶ
  - 一覧は、`social` が友達を1ページ分取得したあと、その相手IDの範囲で `getSharingFor` を1回呼んで合わせる（SQLのJOINはしない）
- 認証は T-01 の `requireAuth` を使い、閲覧者IDは `c.var.viewer.userId` からだけ得る
- 他人の情報は公開プロフィール（`id`、`displayName`、`avatarUrl`）だけを返す（api-conventions）

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/invite-links` | Bearer | JSON：`createInviteLinkRequestSchema` `{ expiresInDays: 1 \| 3 \| 7, maxUses: 1〜10 }` | 201：`createdInviteLinkSchema` `{ id, url, expiresAt, maxUses, uses }` | 400 `validation_failed`、409 `invalid_state`（表示名が未設定）、429 `rate_limited` |
| GET | `/api/v1/invite-links` | Bearer | query：`limit`、`cursor` | 200：`{ items: inviteLinkSchema[], nextCursor }`（`url` は含まない） | 400 |
| POST | `/api/v1/invite-links/{id}/revoke` | Bearer | なし | 204（自分のリンクなら、無効化済み・期限切れでも204） | 404 `not_found`（他人のリンク・存在しない） |
| POST | `/api/v1/invite-links/lookup` | なし（Origin） | JSON：`inviteLookupRequestSchema` `{ token? }`（省略時は招待Cookieのトークン） | 200：`inviteLookupResponseSchema` `{ linkId, inviter: { displayName, avatarUrl } }`（招待Cookieを発行） | 404 `not_found`、401（Origin不一致） |
| POST | `/api/v1/invite-links/accept` | Bearer＋Origin | JSON：`acceptInviteRequestSchema` `{ linkId }`（`lookup` で表示したリンク。トークンは招待Cookieのものを使う） | 201（友達になった）／200（すでに友達）：`acceptInviteResponseSchema` `{ friend: publicProfile, alreadyFriends }` | 404 `not_found`、409 `invalid_state`（自分のリンク） |
| PATCH | `/api/v1/me` | Bearer | JSON：`updateMeRequestSchema` `{ displayName }`（1〜20文字） | 200：`meResponseSchema` | 400 |
| GET | `/api/v1/friends` | Bearer | query：`limit`、`cursor` | 200：`{ items: friendSchema[], nextCursor }` | 400 |
| PATCH | `/api/v1/friends/{friendId}` | Bearer | JSON：`updateFriendRequestSchema` `{ sharesMyAvailability: boolean }` | 200：`friendSchema` | 400、404 `not_found` |
| DELETE | `/api/v1/friends/{friendId}` | Bearer | なし | 204 | 404 `not_found` |

- スキーマは `packages/shared/src/schemas/social.ts`
- `inviteLinkSchema`：`{ id, expiresAt, maxUses, uses, createdAt }`。一覧は有効なリンク（無効化されておらず、期限内で、上限に達していない）だけを返す
- `friendSchema`：`{ id, displayName, avatarUrl, sharesMyAvailability, friendsSince }`。`id` は相手のユーザーID。`sharesMyAvailability` は「自分のここ暇をこの友達に見せるか」
- 一覧の並び順：招待リンクは作成日時の新しい順、友達は友達になった日時の新しい順。同じなら `id` の降順（api-conventions の既定）。カーソルは並び順のキーと `id` を base64url にしたもの
- 招待リンクのURL：`${APP_ORIGIN}/invite#t=<トークン>`。トークンはフラグメントに入れ、サーバーのログやRefererに残さない。発行時の応答でだけ返し、あとから取得する方法はない（D1にはハッシュだけを保存するため）
- 例外：
  - 使えないリンク（存在しない・期限切れ・人数上限・無効化）は、`lookup`・`accept` とも、すべて404 `not_found` にする。409 `expired` と区別しない。リンクを持っている人に、発行者が無効化したのか期限が切れたのかを推測させないため。画面では「このリンクは使えません。発行した人に新しいリンクをもらってください」と1種類だけ表示する
  - `lookup` はトークンを本文で受け取るため `POST` にする（パスやqueryに入れるとログに残る）。データは変えず、招待Cookieを発行するだけ
  - `accept` のトークンは本文ではなく招待Cookieのものを使う。本文の `linkId` は「画面に表示したリンクと同じか」の照合にだけ使う
  - 招待リンクの無効化は、行を消さずに `revoked_at` を入れる状態遷移なので、規約どおり動詞のサブリソースへの `POST /invite-links/{id}/revoke` にする（何度送っても204）
  - 作成の201に `Location` を付けない。招待リンクにも友達にも1件を取得するAPIがないため（指す先がない）
  - 作成・状態遷移の `POST` で `Idempotency-Key` を受け付ける規約は、今回は実装しない（決定事項6）。代わりに次のように扱う
    - `accept`：同じ人が同時に2回送っても、友達関係の行で1回分だけが人数を消費する（「友達になる」の手順）。成功の応答が届かずに再送した場合は、招待Cookieが消えているので404になる。フロントは「友達になる」を送信中は押せなくし、通信エラーのときは再送せず「友達一覧で確認してください」と友達タブへの導線を出す
    - `POST /invite-links`：二重送信はリンクが2本できるだけで、どちらも無効化できる。フロントは送信中はボタンを押せなくする
  - `api-conventions` スキルの `expired` の例（「招待リンクの有効期限」）は、合意したら実装PRでこの仕様に合わせて直す

## データ
マイグレーション `apps/api/migrations/0002_social.sql` を追加する。日時はUnixミリ秒の整数。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `invite_links` | `id`（UUID、PK）、`owner_id`（FK users）、`token_hash`（SHA-256、base64url、UNIQUE）、`max_uses`、`uses`（既定0）、`expires_at`、`revoked_at`（null可）、`created_at` | INDEX(`owner_id`, `created_at`, `id`) |
| `friendships` | `user_id`（FK users）、`friend_id`（FK users）、`created_at` | PK(`user_id`, `friend_id`)。1組の友達を両方向の2行で持つ（どちらの側からも `WHERE user_id = :viewerId` で引ける）。INDEX(`user_id`, `created_at`, `friend_id`) |
| `sharing_policies` | `owner_id`（FK users）、`target_id`（FK users）、`visible`（0／1）、`updated_at` | PK(`owner_id`, `target_id`)。行がなければ「見せる」（F-07の初期値）。友達を解除しても消さない（決定事項の候補：決定事項5） |

- Drizzleのスキーマは `apps/api/src/social/infra/schema.ts` と `apps/api/src/availability/infra/schema.ts`
- 招待リンクのトークンは32バイトのランダム値のbase64url（api-conventions）。D1にはハッシュだけを保存する（T-01の `apps/api/src/shared/crypto.ts` を使う）

## 振る舞い

### 招待リンクの発行
- 期限は1・3・7日から選ぶ（既定3日）。人数上限は1〜10人（既定5人）（決定事項1）
- 発行者の表示名が未設定（`null`）なら409 `invalid_state`。受け口で発行者の名前を見せて確かめてもらうため（「表示名」の節）
- 1人が24時間に発行できるのは20本まで。無効化したリンクも数える。発行の前に、閲覧者が直近24時間に作った行をD1で数え、20以上なら429 `rate_limited` と、その中で一番古い発行から24時間たつまでの秒数を `Retry-After` に入れる（決定事項4）。数えてから作るまでの間に同時に送られた分は、上限をわずかに超えることを許容する
- 応答の `url` は発行時だけ返す

### 招待リンクの受け口（フロント）
- `/invite` は、`/auth/complete` と同じく、ログイン状態の振り分け（未ログインなら `/login` へ移す処理）より前に描画する。振り分けると、`lookup` の前にフラグメントのトークンを失うため
- `/invite#t=<トークン>` を開いたら、フラグメントのトークンを読み、すぐ `history.replaceState` でURLから消す
- `POST /invite-links/lookup` で発行者の表示名とアイコンを表示する。表示名が未設定なら「友達」と表示する
- トークンはブラウザのストレージ（localStorage・sessionStorage）に置かない。ログインをはさんでも失わないよう、`lookup` が有効なリンクのときに、サーバーが招待Cookieを発行する（決定事項2）
  - `__Host-kh_invite=<トークン>`、HttpOnly、Secure、`SameSite=Lax`、Path=/、Max-Age=3600
  - `accept` はこのCookieのトークンを使い、201・200・404・409 のときにCookieを消す。401（アクセストークンの失効・Originの不一致）では消さない（APIクライアントが更新して再送するため）。`lookup` が404のときも消す
  - T-01の `logout`・`logout-all` も招待Cookieを消す（共有の端末で、次の人に前の人の招待を引き継がないため）
  - `lookup`・`accept` はCookieを扱うので、T-01と同じく `Origin` が `APP_ORIGIN` と一致しなければ401
- 未ログインなら「Googleでログイン」「Appleでログイン」を出す（`returnTo=/invite`）。ログイン後に `/invite` に戻ったら（フラグメントはない）、本文なしの `lookup` で招待Cookieから発行者を引き、表示名とアイコンを表示してから「友達になる」を出す。誰と友達になるのかを見せずに確定させない
- ログイン済みでも、友達になるのは「友達になる」を1回押したとき（決定事項8）
- 招待Cookieがない（1時間たった、別のブラウザ）ときは、`accept` が404になり「このリンクは使えません」と同じ表示になる
- ログイン済みなら「友達になる」ボタンで `accept` を呼ぶ。友達になったら友達タブへ移る
- 使えないリンク（404）は、静かな文言1種類で表示する（赤を使わない）
- 自分のリンク（`accept` が409）は「これはあなたが作ったリンクです。友達に送ってください」と静かに表示する

### 友達になる（`accept`）
1. 招待Cookieのトークンのハッシュでリンクを取得する。Cookieがない・リンクがない・期限切れ・無効化・上限に達している、のどれでも404
2. 取得したリンクの `id` が本文の `linkId` と一致しなければ404。別のタブで別のリンクを開いて招待Cookieが上書きされたときに、画面に出ていない相手と友達になるのを防ぐ（Cookieは消さない。正しいタブから開き直せば続けられる）
3. 発行者が閲覧者自身なら409 `invalid_state`
4. 閲覧者側の友達関係の行（`user_id = 閲覧者, friend_id = 発行者`）を `INSERT OR IGNORE` で単独で書く
   - `meta.changes` が0なら、すでに友達。人数を消費せず、7へ（発行者側の行の修復）
   - 同じ人が同時に2回送っても、ここで1回分だけが5へ進む
5. `UPDATE invite_links SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?` を単独で実行する。`meta.changes` が0なら（同時に使われて上限に達した、無効化された）、4で書いた行を消して404
6. 発行者側の友達関係の行（`INSERT OR IGNORE`）と、`outbox` の `FriendshipEstablished` 2件（発行者あて・参加者あて）をバッチで書いて201
7. すでに友達だったとき：閲覧者側の行が60秒より前に書かれていれば、発行者側の行を `INSERT OR IGNORE` で書く（60秒以内なら、同時に送られた別のリクエストが処理中なので触らない。触ると `FriendshipEstablished` が重複する）。行が増えた（＝前回の `accept` が5と6の間で落ちて片方向だけが残っていた）ときは、6と同じ `FriendshipEstablished` 2件も書く。どちらでも200（`alreadyFriends: true`）
- 途中で落ちた場合の扱い：
  - 5と6の間で落ちる：閲覧者側の行だけが残り、人数は消費済み。次の `accept` が7で修復する（人数は再び消費しない）。修復されるまでの間、友達一覧は片方にだけ相手が出る
  - 5で失敗したあと4の行を消す前に落ちる：閲覧者側の行だけが残り、人数は消費していない。次の `accept` が7で発行者側の行を書くので、人数を消費せずに友達になる。上限を1人分超えうるが、障害時に限られるので許容する
- 4から6の間、閲覧者側の行だけがある瞬間がある。この間に閲覧者自身の友達一覧を取ると発行者が一瞬見えることがあるが、5で失敗すれば消えるので許容する
- 同じ人が同時に2回送り、1回目が5で失敗した場合、2回目は4で「すでに友達」と判断して200を返すが、実際には友達になっていない。二重押しと上限ちょうどが重なったときだけなので許容する（フロントは送信中に押せなくする）
- `FriendshipEstablished` のペイロード：`{ userId（通知の受け取り手）, friendId, occurredAt }`。メールアドレスや表示名は入れない。通知と「公開をオフにする」導線は通知タスクで作る
- 解除した相手が同じリンクを再び開いた場合も、通常どおり人数を1消費して友達に戻る（F-09）

### 友達の解除
- `DELETE /friends/{friendId}`：両方向の `friendships` を1つのバッチで消す。相手には通知しない。outboxにも何も書かない
- 友達でない（存在しないユーザーを含む）なら404
- `sharing_policies` は消さない。友達に戻ったときも、以前の「見せない」が残る

### 公開設定の切り替え
- `PATCH /friends/{friendId}`：友達のときだけ `sharing_policies` を upsert する。友達でなければ404
- 応答は更新後の `friendSchema`
- 友達一覧の `sharesMyAvailability` は `sharing_policies.visible`（行がなければ `true`）

### 表示名
- T-01では、表示名は初回設定（別のタスク）まで全員 `null`。このままでは、受け口で「誰と友達になるのか」を確かめられない（決定事項8）
- そのため、このタスクで表示名の設定だけを先に作る：`PATCH /api/v1/me` `{ displayName }`（前後の空白を除いて1〜20文字、制御文字は不可）。identity コンテキストに置く。アイコンや初回設定の流れは別タスク
- 招待リンクは、表示名を設定した人だけが発行できる（未設定なら409）。友達タブで「招待リンクを作る」を押したときに未設定なら、先に表示名の入力を出す
- それでも友達一覧には、表示名が未設定の相手（リンクを受けただけの人）が出うる。APIは `null` のまま返し、画面では「名前未設定の友達」と表示する
- 表示名は本人が自由に決められる値なので、「偽の招待ページ」（なりすまし）への対策としては弱い。受け口の表示は「この名前の人のリンク」以上を保証しないことを受け入れる（決定事項9）。取り違えたときは、友達追加の通知から公開をオフにでき、静かに解除もできる（要求定義書の受容したリスク）
- E2Eで相手を見分けるため、`/__e2e__/login` に任意の `displayName`（1〜32文字）を受け付けさせ、テスト用ユーザーに表示名を入れる（E2E用のエントリだけの変更）

### 画面（仮。最終的なデザインはデザインのタスクで差し替える）
- 友達タブ（`/friends`）：友達一覧（表示名、「自分の暇を見せる」スイッチ、解除）、「招待リンクを作る」
- 招待リンクの発行：期限と人数を選んで作り、URLをコピー（`navigator.clipboard`）またはWeb Share APIで共有する。作ったURLはこの画面でしか表示できないことを伝える
- 自分の有効なリンクの一覧と「無効にする」
- スイッチは楽観的更新にする（data-fetching スキル）。失敗したら元に戻し、静かな文言を出す
- 解除は確認を1回だけはさむ（「解除しても相手には通知されません」）

## 認可と秘匿
- 閲覧者IDの使い方：すべて `requireAuth` の閲覧者IDだけを使う。パスの `friendId`・`id` は「閲覧者の持ち物の中から探すキー」としてだけ使う
  - 招待リンクの無効化：`WHERE id = :id AND owner_id = :viewerId`
  - 友達一覧：`WHERE user_id = :viewerId`
  - 解除・公開設定：`WHERE user_id = :viewerId AND friend_id = :friendId` で友達であることを確かめる
- 他人のデータに届かないことの保証：上の条件をSQLに入れる。取得後にアプリ側で絞り込まない。他人のリンクの無効化、友達でない人の解除・公開設定の変更は、存在しない場合と同じ404
- 区別させない応答：
  - 使えないリンクは、理由にかかわらず同じ404（`lookup`・`accept`）
  - 友達一覧で、相手が自分に暇を見せているかどうかは返さない（自分の設定 `sharesMyAvailability` だけを返す）
  - `lookup` は未ログインでも呼べるが、返すのは発行者の表示名とアイコンだけ（IDは返さない）
- ログ：トークン、表示名を出さない

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 発行：トークンは32バイトのbase64urlで、D1にはハッシュだけ。`url` は発行時の応答にだけ含まれ、一覧には含まれない
- [ ] 発行：期限・人数の入力検証（範囲外は400）、既定値
- [ ] 発行：24時間に20本を超えると429と `Retry-After`
- [ ] 一覧：有効なリンクだけを、作成日時の新しい順で返す。カーソルで続きを取れる
- [ ] 無効化（`POST /invite-links/{id}/revoke`）：自分のリンクは204（無効化済み・期限切れでも204）、他人のリンク・存在しないIDは同じ404
- [ ] 発行：表示名が未設定なら409
- [ ] 表示名の設定：1〜20文字（前後の空白を除く）、制御文字は400。他人の表示名は変えられない（閲覧者自身の行だけを更新する）
- [ ] lookup：有効なら発行者の表示名とアイコン（IDは含まない）。存在しない・期限切れ・上限・無効化は、すべて同じ404（本文も同じ）
- [ ] accept：友達になると両方向の行と `FriendshipEstablished` 2件ができ、人数が1増える
- [ ] accept：すでに友達なら200で、人数が増えない
- [ ] accept：同じ人が同時に2回送ると、人数は1だけ増え、`FriendshipEstablished` は2件だけ
- [ ] accept：本文の `linkId` が招待Cookieのリンクと違えば404で、友達にならない（別のタブで招待Cookieが上書きされた場合）
- [ ] accept：閲覧者側の行だけが残った状態（途中で落ちた）から `accept` すると、人数を消費せずに発行者側の行と `FriendshipEstablished` 2件を書いて修復する
- [ ] accept：401（アクセストークンの失効）では招待Cookieを消さない
- [ ] lookup：本文なしなら招待Cookieのトークンで発行者を返す。Cookieもなければ404
- [ ] logout・logout-all：招待Cookieも消す
- [ ] accept：自分のリンクは409
- [ ] accept：期限切れ・上限・無効化は404。上限1のリンクを2人が同時に使うと、1人だけ成功する
- [ ] accept：解除した相手が同じリンクで友達に戻れる（人数を消費する）
- [ ] 友達一覧：自分の友達だけを、友達になった日時の新しい順で返す。相手の公開設定は含まない。他人の公開プロフィール以外の項目（メールアドレスなど）を返さない
- [ ] 解除：両方向が消え、outboxに何も書かれない。友達でない・存在しないユーザーは同じ404
- [ ] 公開設定：切り替えが保存され、一覧に反映される。解除して友達に戻っても残る。友達でない人には404
- [ ] 他人のIDでは取得・更新できない：AのトークンでBのリンクを無効化できない。Aの一覧にBの友達が出ない。AがB–C間の解除・公開設定を変えられない
- [ ] 招待Cookie：`lookup` が有効なら発行し（HttpOnly、Secure、SameSite=Lax、`__Host-`、1時間）、404なら消す。`accept` は結果にかかわらず消す。Cookieがなければ `accept` は404
- [ ] `lookup`・`accept` は Origin がない・別のOriginなら401
- [ ] フロント：受け口でトークンをURLから消し、localStorage・sessionStorage に置かない
- [ ] フロント：未ログインで `/invite#t=...` を開いても `/login` へ移さずに受け口を描画する。ログインのボタンは `returnTo=/invite` でログインを始める
- [ ] フロント：ログイン後の `/invite` では、発行者を表示してから「友達になる」を出し、`lookup` で受け取った `linkId` を送る。409では自分のリンクの文言、通信エラーでは友達タブへの導線を出す
- [ ] フロント：表示名が `null` の友達を「名前未設定の友達」と表示する
- [ ] フロント：公開設定のスイッチの楽観的更新（成功時、失敗時に元に戻る）

### E2Eテスト（対象にする利用者の流れ）
- [ ] ユーザーAがリンクを作り、ログイン済みのユーザーB（別のブラウザコンテキスト）がそのリンクを開いて「友達になる」と、双方の友達一覧に相手が出る
- [ ] 未ログインでリンクを開くとログインを求められる。そのブラウザでテスト用ログインをしてから `/invite` を開くと、招待Cookieが残っていて、発行者の表示名が出て友達になれる（`returnTo` で戻ること自体は単体テストで確かめる。テスト用ログインは `returnTo` を通らないため）
- [ ] Aが無効化したリンクをBが開くと「このリンクは使えません」が表示される
- [ ] AがBを解除すると、双方の一覧から消える
- 公開設定のスイッチは単体テストで確かめる（見え方への影響はT-03のE2Eで確かめる）

## スコープ外
- 通知の送信（`FriendshipEstablished` を outbox に書くだけ）
- ここ暇の表示への公開設定の適用（T-03）
- 監査ログ（公開設定の変更の30日保持）。T-01と同じく監査ログのタスクでまとめて行う
- ブロック（要件でなし）、退会（F-17）
- `Idempotency-Key`（決定事項6）
- 最終的な画面デザイン
- 友達の詳細の画面（相手が見せているここ暇を含むため、T-03で作る）

## 決定事項（仕様書PRのレビューで合意）
1. 招待リンクの期限は1・3・7日から選ぶ（既定3日）。人数上限は1〜10人（既定5人）
2. ログインをはさむ間、招待リンクのトークンはサーバーが発行するHttpOnlyの招待Cookie（1時間）で持ち越す。ブラウザのストレージや `returnTo` には入れない
3. 使えないリンクの理由（期限切れ・上限・無効化）は、利用者にも区別して見せない
4. 招待リンクの発行は、1人あたり24時間に20本まで
5. 「自分の暇を見せる」の設定は、友達を解除しても残す
6. 規約の `Idempotency-Key`（KVに24時間保存）は、KVのバインディングとまとめて別のタスクで共通の仕組みとして作る
7. `FriendshipEstablished` は、発行者・参加者の両方あてに書く
8. F-08の「開いてログインすると即友達」は、「発行者の表示名を見せたうえで『友達になる』を1回押す」と解釈する
9. 表示名の設定（`PATCH /me`）をこのタスクで先に作り、表示名を設定した人だけが招待リンクを発行できるようにする。表示名は自由に決められるため、なりすましへの対策としては弱いことを受け入れる（仕様書PRのレビューで追加）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-07 | 初版 | T-02の仕様書PR |
| 2026-10-07 | 同じ人の同時の `accept` で人数を二重に消費しない手順、招待Cookieからの発行者の表示、表示名が未設定のときの表示、未ログインの `/invite` の扱い、自分のリンク、無効化の冪等性、`Location` の例外、発行の上限の数え方を追加。確認事項8を追加 | 仕様レビュー |
| 2026-10-07 | 確認事項を決定事項にし、状態を合意済みにした | 仕様書PRのレビュー |
| 2026-10-07 | `accept` で表示したリンクと一致するかを照合（`linkId`）、すでに友達のときに発行者側の行を修復、表示名の設定（`PATCH /me`）と発行の前提、コンテキストの境界、無効化を `POST .../revoke` に変更、途中で落ちた場合の扱いを追加。決定事項9を追加 | 仕様書PRのレビュー（pryusei/kokohima-app#9） |
| 2026-10-07 | 状態を実装済みにした。手順7の修復は、閲覧者側の行が60秒より前に書かれたときだけ行う（同時の `accept` で、処理中の行を修復と誤ってイベントを重複して書いていたため） | 実装PR |
