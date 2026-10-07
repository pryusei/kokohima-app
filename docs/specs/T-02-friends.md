# T-02 仕様書：友達と招待リンク

- 状態：下書き
- タスク票：docs/tasks/T-02-friends.md
- 関係する要件：F-07、F-08、F-09、要求定義書「受容したリスク」「残りの論点」（招待リンクのデフォルト値・トークン設計）

## 概要
招待リンクを開いてログインした人と発行者が、その場で友達になる。友達は静かに解除でき、友達ごとに「自分の暇を見せる」を切り替えられる。
友達関係と公開設定は、以降のここ暇・誘いのAPIが「閲覧者に見せてよいか」をSQLで判定するための土台になる。

## 前提
- コンテキスト：友達関係と招待リンクは `social`（`apps/api/src/social/`）、公開設定は `availability`（`apps/api/src/availability/`）に置く。公開設定の保存と切り替えのAPIは今回作り、ここ暇への適用はT-03で行う
- 認証は T-01 の `requireAuth` を使い、閲覧者IDは `c.var.viewer.userId` からだけ得る
- 他人の情報は公開プロフィール（`id`、`displayName`、`avatarUrl`）だけを返す（api-conventions）

## API
`api-conventions` スキルに従う。例外は「例外」の欄に書く。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/invite-links` | Bearer | JSON：`createInviteLinkRequestSchema` `{ expiresInDays: 1 \| 3 \| 7, maxUses: 1〜10 }` | 201：`createdInviteLinkSchema` `{ id, url, expiresAt, maxUses, uses }` | 400 `validation_failed`、429 `rate_limited` |
| GET | `/api/v1/invite-links` | Bearer | query：`limit`、`cursor` | 200：`{ items: inviteLinkSchema[], nextCursor }`（`url` は含まない） | 400 |
| DELETE | `/api/v1/invite-links/{id}` | Bearer | なし | 204（自分のリンクなら、無効化済み・期限切れでも204） | 404 `not_found`（他人のリンク・存在しない） |
| POST | `/api/v1/invite-links/lookup` | なし（Origin） | JSON：`inviteLookupRequestSchema` `{ token? }`（省略時は招待Cookieのトークン） | 200：`inviteLookupResponseSchema` `{ inviter: { displayName, avatarUrl } }`（招待Cookieを発行） | 404 `not_found`、401（Origin不一致） |
| POST | `/api/v1/invite-links/accept` | Bearer＋Origin | なし（招待Cookieのトークンを使う） | 201（友達になった）／200（すでに友達）：`acceptInviteResponseSchema` `{ friend: publicProfile, alreadyFriends }` | 404 `not_found`、409 `invalid_state`（自分のリンク） |
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
  - `accept` は本文を取らず、招待Cookieのトークンを使う
  - 作成の201に `Location` を付けない。招待リンクにも友達にも1件を取得するAPIがないため（指す先がない）
  - 作成・状態遷移の `POST` で `Idempotency-Key` を受け付ける規約は、今回は実装しない（確認事項6）。代わりに次のように扱う
    - `accept`：同じ人が同時に2回送っても、友達関係の行で1回分だけが人数を消費する（「友達になる」の手順）。成功の応答が届かずに再送した場合は、招待Cookieが消えているので404になる。フロントは「友達になる」を送信中は押せなくし、通信エラーのときは再送せず「友達一覧で確認してください」と友達タブへの導線を出す
    - `POST /invite-links`：二重送信はリンクが2本できるだけで、どちらも無効化できる。フロントは送信中はボタンを押せなくする
  - `api-conventions` スキルの `expired` の例（「招待リンクの有効期限」）は、合意したら実装PRでこの仕様に合わせて直す

## データ
マイグレーション `apps/api/migrations/0002_social.sql` を追加する。日時はUnixミリ秒の整数。

| テーブル | 列 | 備考 |
| --- | --- | --- |
| `invite_links` | `id`（UUID、PK）、`owner_id`（FK users）、`token_hash`（SHA-256、base64url、UNIQUE）、`max_uses`、`uses`（既定0）、`expires_at`、`revoked_at`（null可）、`created_at` | INDEX(`owner_id`, `created_at`, `id`) |
| `friendships` | `user_id`（FK users）、`friend_id`（FK users）、`created_at` | PK(`user_id`, `friend_id`)。1組の友達を両方向の2行で持つ（どちらの側からも `WHERE user_id = :viewerId` で引ける）。INDEX(`user_id`, `created_at`, `friend_id`) |
| `sharing_policies` | `owner_id`（FK users）、`target_id`（FK users）、`visible`（0／1）、`updated_at` | PK(`owner_id`, `target_id`)。行がなければ「見せる」（F-07の初期値）。友達を解除しても消さない（決定事項の候補：確認事項5） |

- Drizzleのスキーマは `apps/api/src/social/infra/schema.ts` と `apps/api/src/availability/infra/schema.ts`
- 招待リンクのトークンは32バイトのランダム値のbase64url（api-conventions）。D1にはハッシュだけを保存する（T-01の `apps/api/src/shared/crypto.ts` を使う）

## 振る舞い

### 招待リンクの発行
- 期限は1・3・7日から選ぶ（既定3日）。人数上限は1〜10人（既定5人）（確認事項1）
- 1人が24時間に発行できるのは20本まで。無効化したリンクも数える。発行の前に、閲覧者が直近24時間に作った行をD1で数え、20以上なら429 `rate_limited` と、その中で一番古い発行から24時間たつまでの秒数を `Retry-After` に入れる（確認事項4）。数えてから作るまでの間に同時に送られた分は、上限をわずかに超えることを許容する
- 応答の `url` は発行時だけ返す

### 招待リンクの受け口（フロント）
- `/invite` は、`/auth/complete` と同じく、ログイン状態の振り分け（未ログインなら `/login` へ移す処理）より前に描画する。振り分けると、`lookup` の前にフラグメントのトークンを失うため
- `/invite#t=<トークン>` を開いたら、フラグメントのトークンを読み、すぐ `history.replaceState` でURLから消す
- `POST /invite-links/lookup` で発行者の表示名とアイコンを表示する。表示名が未設定なら「友達」と表示する
- トークンはブラウザのストレージ（localStorage・sessionStorage）に置かない。ログインをはさんでも失わないよう、`lookup` が有効なリンクのときに、サーバーが招待Cookieを発行する（確認事項2）
  - `__Host-kh_invite=<トークン>`、HttpOnly、Secure、`SameSite=Lax`、Path=/、Max-Age=3600
  - `accept` はこのCookieのトークンを使い、201・200・404・409 のときにCookieを消す。401（アクセストークンの失効・Originの不一致）では消さない（APIクライアントが更新して再送するため）。`lookup` が404のときも消す
  - T-01の `logout`・`logout-all` も招待Cookieを消す（共有の端末で、次の人に前の人の招待を引き継がないため）
  - `lookup`・`accept` はCookieを扱うので、T-01と同じく `Origin` が `APP_ORIGIN` と一致しなければ401
- 未ログインなら「Googleでログイン」「Appleでログイン」を出す（`returnTo=/invite`）。ログイン後に `/invite` に戻ったら（フラグメントはない）、本文なしの `lookup` で招待Cookieから発行者を引き、表示名とアイコンを表示してから「友達になる」を出す。誰と友達になるのかを見せずに確定させない
- ログイン済みでも、友達になるのは「友達になる」を1回押したとき（確認事項8）
- 招待Cookieがない（1時間たった、別のブラウザ）ときは、`accept` が404になり「このリンクは使えません」と同じ表示になる
- ログイン済みなら「友達になる」ボタンで `accept` を呼ぶ。友達になったら友達タブへ移る
- 使えないリンク（404）は、静かな文言1種類で表示する（赤を使わない）
- 自分のリンク（`accept` が409）は「これはあなたが作ったリンクです。友達に送ってください」と静かに表示する

### 友達になる（`accept`）
1. 招待Cookieのトークンのハッシュでリンクを取得する。Cookieがない・リンクがない・期限切れ・無効化・上限に達している、のどれでも404
2. 発行者が閲覧者自身なら409 `invalid_state`
3. 閲覧者側の友達関係の行（`user_id = 閲覧者, friend_id = 発行者`）を `INSERT OR IGNORE` で単独で書く。`meta.changes` が0なら、すでに友達なので人数を消費せず200（`alreadyFriends: true`）。同じ人が同時に2回送っても、ここで1回分だけが先へ進む
4. `UPDATE invite_links SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ?` を単独で実行する。`meta.changes` が0なら（同時に使われて上限に達した、無効化された）、3で書いた行を消して404
5. 発行者側の友達関係の行（`INSERT OR IGNORE`）と、`outbox` の `FriendshipEstablished` 2件（発行者あて・参加者あて）をバッチで書いて201
- 3から5の間、閲覧者側の行だけがある瞬間がある。この間に閲覧者自身の友達一覧を取ると発行者が一瞬見えることがあるが、4で失敗すれば消えるので許容する
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

### 表示名が未設定の相手
- T-01では、表示名は初回設定（別のタスク）まで全員 `null`。APIは `null` のまま返し、画面では「名前未設定の友達」と表示する（受け口では「友達」）
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
- [ ] 無効化：自分のリンクは204（無効化済み・期限切れでも204）、他人のリンク・存在しないIDは同じ404
- [ ] lookup：有効なら発行者の表示名とアイコン（IDは含まない）。存在しない・期限切れ・上限・無効化は、すべて同じ404（本文も同じ）
- [ ] accept：友達になると両方向の行と `FriendshipEstablished` 2件ができ、人数が1増える
- [ ] accept：すでに友達なら200で、人数が増えない
- [ ] accept：同じ人が同時に2回送ると、人数は1だけ増え、`FriendshipEstablished` は2件だけ
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
- [ ] フロント：ログイン後の `/invite` では、発行者を表示してから「友達になる」を出す。409では自分のリンクの文言、通信エラーでは友達タブへの導線を出す
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
- `Idempotency-Key`（確認事項6）
- 最終的な画面デザイン
- 友達の詳細の画面（相手が見せているここ暇を含むため、T-03で作る）

## 確認事項（合意前に解消する）
1. 招待リンクの期限と人数上限：期限は1・3・7日から選択（既定3日）、人数は1〜10人（既定5人）でよいか（要求定義書の残りの論点。モックは3日・5人）
2. ログインをはさむ間、招待リンクのトークンをサーバーが発行するHttpOnlyの招待Cookie（1時間）で持ち越してよいか。ブラウザのストレージに置くとスクリプトから読め、`returnTo` に入れるとT-01の `oauth_transactions` と `login_codes` にトークンが平文で残るため、どちらも避ける
3. 使えないリンクの理由（期限切れ・上限・無効化）を、利用者にも区別して見せない方針でよいか
4. 招待リンクの発行のレート制限を、1人あたり24時間に20本としてよいか（要求定義書の「招待リンク発行などのレート制限の値」）
5. 「自分の暇を見せる」の設定を、友達を解除しても残してよいか（再び友達になったときに「見せる」に戻らないようにするため）
6. 規約の `Idempotency-Key`（KVに24時間保存）は、KVのバインディングとまとめて別のタスクで共通の仕組みとして作ってよいか
7. `FriendshipEstablished` を、発行者・参加者の両方あてに書いてよいか（要件は「友達追加時に通知し、通知から公開をオフにできる」で、どちらに通知するかは書かれていない）
8. F-08の「開いてログインすると即友達」を、「発行者の表示名を見せたうえで『友達になる』を1回押す」と解釈してよいか。友達になると初期値「見せる」でここ暇が公開されるため、誰と友達になるのかを確かめる1タップをはさむ

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-10-07 | 初版 | T-02の仕様書PR |
| 2026-10-07 | 同じ人の同時の `accept` で人数を二重に消費しない手順、招待Cookieからの発行者の表示、表示名が未設定のときの表示、未ログインの `/invite` の扱い、自分のリンク、無効化の冪等性、`Location` の例外、発行の上限の数え方を追加。確認事項8を追加 | 仕様レビュー |
