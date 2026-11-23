# T-24 仕様書：問い合わせのフォーム

- 状態：実装済み
- タスク票：docs/tasks/T-24-contact.md
- 関係する要件：要求定義書「機能要件」F-22 問い合わせ、「AI時代の攻撃を前提にした運用」（保存するデータを減らす）、「悪用対策と運用」。T-01（認証・メールアドレス）、T-10（冪等キー・回数の上限）、T-11・T-20（画面）、T-12（リリースの秘密情報）、T-13（監視・退避キュー）、T-16（退会）、T-17（保持期間）、T-18（画面のエラーの経路の一覧）、T-19（プライバシー ポリシー「3.」8・「8.」・「9.」・「12.」）、T-21（WebKit の E2E）

## 概要
- 今、運営への連絡は `ops@kokohima.app` へのメールだけで、アプリの中から不具合やご意見を送る方法がない。ログインしている利用者が、設定から種類を選んで内容を書き、運営に送れるフォームを作る。
- 送った内容は、運営者だけが入る Slack の非公開のチャンネル（`#kokohima-contact`）に、Incoming Webhook で届ける。API は outbox に1行書くだけにし、Slack への送信は Queues の consumer が行う（CLAUDE.md「外部連携は outbox 経由」）。内容は D1 の outbox の行にだけ置き、Queue のメッセージには受付番号（outbox の `id`）だけを載せる。届けたら D1 からも内容を消す。
- ログインできない人は、今までどおり `ops@kokohima.app` にメールで連絡する（プライバシー ポリシー・利用規約に書いてある）。

## 決めたこと（利用者の回答）
1. 送れるのはログインしている人だけ。
2. 届け先は Slack（Incoming Webhook）。
3. 利用者が種類を選ぶ。
4. Slack のワークスペースは、一旦、無料のプランのままにする。保持の設定で、問い合わせのメッセージを90日で消す（「振る舞い 6.」。無料のプランでできるかは「確認事項」）。
5. 入口は、設定のトップの節「このアプリについて」に置く（「振る舞い 9.」）。
6. 種類は4つ：不具合／ご意見／個人情報の開示・削除の請求／その他。
7. 受け付けたことは画面にだけ出し、利用者への自動の返信メールは送らない。
8. 届け先は、監視の2つのチャンネル（T-13）とは別の、問い合わせ専用の非公開のチャンネル `#kokohima-contact`。
9. 内容は1000文字まで、回数は1人直近24時間に3件まで。
10. 実装は先にデプロイしてよいが、入口の表示と受け付けは、プライバシー ポリシーの改定日（効力が生じる日）から始める。T-19 の改定（PR #146 の7日前の予告）と時期を合わせれば、1回の予告で両方を知らせてよい（「振る舞い 11.」）。

ほかのこと（payload の持ち方、Slack の文の組み方、画面の細部など）は、この仕様書からの提案で、「決定事項」にまとめる。

## 前提

### コンテキストの分担
- 新しいコンテキスト `contact` を作る：`apps/api/src/contact/{domain,application,infra}` と `routes.ts`。CLAUDE.md の「アーキテクチャ」のコンテキストの一覧に `contact` を足す（実装PR）。
  - `domain/`：種類の一覧、Slack に送る文の組み立て（特殊文字のエスケープと `section` の分け方）、webhook の URL の形の確かめ（`new URL()` の結果を見る純粋な関数）。fetch・D1・Hono を import しない。
  - `application/`：受け付け（outbox への書き込みと回数の上限）、届ける処理（consumer から呼ぶ `deliverContactMessage(ctx, outboxId)`）。
  - `infra/`：D1 の文（outbox の行の書き込み・読み取り・書き換え）、Slack の Incoming Webhook への送信（`deps.fetch`）。
- contact から identity の表（`users`）を直接読まない。identity の application に次の2つを足して使う（実装PR）：
  - `activeUserExistsSql(param: string)`：`EXISTS (SELECT 1 FROM users WHERE id = <param> AND withdrawn_at IS NULL)` の SQL の部品を返す。受け付けの1つの文の中で使う（同じ文で確かめないと、退会と同時の送信で行ができるため。T-16「退会した人を扱わない処理」と同じ条件を、identity が持つ1か所から出す）。
  - `getContactSender(env, userId): Promise<{ active: boolean; email: string | null }>`：退会していないかと、返信先のメールアドレス（今の `findEmail` と同じ列）を1回で読む。行がなければ `{ active: false, email: null }`。
  - 今ほかのコンテキストが直接書いている `EXISTS (SELECT 1 FROM users ...)` は、この仕様では変えない。
- 画面は `apps/web/src/contact/`（フォームと送信のフック）と、ページは `apps/web/src/pages/ContactPage.tsx`。
- 用語：画面の「問い合わせ」はコードで `ContactMessage`。「受付番号」は outbox の行の `id`（UUID）で、コードでは `receiptId`。T-13「9.」・手順書「4.」の「問い合わせ番号」（画面に出す `requestId`。最初のリリースでは出さない）とは別のもの。`invitation-domain` スキルの用語表に足す（実装PR）。

### 番号
- T-21（WebKit の E2E）・T-22（行きたいリスト）・T-23（ほかのブランチで使用中）・要件の F-18〜F-21 はほかのタスクで使われているので、このタスクは T-24、要件は F-22 にする。

## API
`api-conventions` に従う。例外は下に理由を書く。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/contact-messages` | 必要（`requireAuth`・`requireActiveSession`・`requireSameOrigin`）。`Idempotency-Key` を受け付ける | body：`contactMessageRequestSchema` | 204（本文なし） | 404 `not_found`（公開の日より前。知らない経路と同じ）、400 `validation_failed`、401 `unauthenticated`（未認証・退会した・同じオリジンでない）、409 `request_in_progress`、422 `idempotency_key_mismatch`、429 `rate_limited`（`Retry-After`） |

- パス：`api-conventions` の「リソースは複数形」に合わせて `/contact-messages` にする（依頼の例の `/contact` ではない）。
- 成功は204。作ったものを読む経路がない（問い合わせを読めるリソースとして外に出さない）ので、201 と `Location` は返さない（T-18 の `client-errors` と同じ）。`api-conventions` の「成功時のステータス」に、この例外を1行足すことを提案する（「実装PRで直すもの」）。
- ミドルウェアと処理の順番（固定）：
  0. 公開の前（`contactStart.json` の `startDate` より前）なら、認証より前に、知らない経路と同じ404 `not_found`（`app.notFound` と同じ応答）を返す（「振る舞い 11.」）。
  1. `requireAuth`
  2. `requireActiveSession`
  3. `requireSameOrigin`：アクセストークンはメモリにあるので CSRF は起きないが、退会（`POST /me/withdrawal`）と同じく、外の事業者に個人情報を送る操作なので重ねて付ける。
  4. 本文の上限：8KiB（8192バイト。UTF-8 のバイト数。`apps/api/src/http/bodyLimit.ts`）。`Content-Length` と読み込んだ長さの両方で確かめ（`Content-Length` が数でなければ400）、超えたら最後まで読まずに400 `validation_failed`（新しい code は足さない。T-18 と同じ）。**`idempotent` より前に置く**（`apps/api/src/http/idempotency.ts` の `idempotent` は本文を `c.req.text()` で最後まで読むため、後ろに置くと大きな本文を読んでハッシュを作り、`idempotency_keys` に行を作ってしまう）。内容の上限（1000文字）をすべて4バイトの文字で書いても4000バイトで、JSON のエスケープ（改行の `\n` など）と項目の名前を足しても収まる値（16KiB から、内容の上限に合わせて半分にした）。
  5. `idempotent`（T-10）：二重に実行すると Slack に2通届く（結果が変わる）ので受け付ける。T-10 の「`Idempotency-Key` を受け付ける経路」の表に足す。`idempotency_keys` に残るのは本文のハッシュと204（本文なし）だけで、内容は残らない。
  6. `contactMessageRequestSchema` で検証。
  7. 受け付け（「振る舞い 1.」）。
- 送り主は、いつもアクセストークンの閲覧者（`c.var.viewer.userId`）。本文に `userId`・`email` などの項目を入れても `.strict()` で400 になり、送り主を偽れない。
- 409 `request_in_progress`・422 `idempotency_key_mismatch` は T-10 の共通の動き。

`contactMessageRequestSchema`（`packages/shared/src/schemas/contact.ts`。`.strict()`）：

| 項目 | 型 | 値 |
| --- | --- | --- |
| `category` | enum | `bug`（不具合）・`feedback`（ご意見）・`privacy_request`（個人情報の開示・削除の請求）・`other`（その他） |
| `body` | string | 下の `contactBodySchema` |

`contactBodySchema`：
- 受け取る生の文字列は8000文字（UTF-16 の長さ）まで（正規化の前の歯止め。内容の上限の8倍で、ひとことの `freeText` と同じ比。超えたら `too_long`）。
- `\r\n` と `\r` を `\n` に、タブを空白1つにそろえ、NFC に正規化し、前後の空白を除く。
- 1〜1000文字（コードポイントで数える。`CONTACT_BODY_MAX = 1000`。ひとことの `messageSchema` と同じ数え方）。空なら `too_short`、超えたら `too_long`。
- 改行は許し、数の上限は付けない（不具合の手順を書けるように）。
- 次の文字があれば `invalid_characters`：改行を除く制御文字（`\p{Cc}`）、孤立サロゲート（`\p{Cs}`）、書字方向を変える文字（U+202A〜U+202E・U+2066〜U+2069）。ほかの書式文字（絵文字をつなぐ U+200D など）は許す。表示名・ひとことと違い、運営者だけが読む文章で、見た目の偽装の害が小さいため。
- `CONTACT_CATEGORIES`・表示の名前（`CONTACT_CATEGORY_LABELS`）・`CONTACT_BODY_MAX`・`CONTACT_DAILY_LIMIT`（3）・`CONTACT_LIMIT_WINDOW_HOURS`（24）も `packages/shared/src/schemas/contact.ts` に置き、API・consumer・画面で同じ値を使う。

## データ
- 新しい表は作らない（マイグレーションなし）。outbox に新しい型 `ContactMessageSubmitted` の行を書く。

`ContactMessageSubmitted` の payload（D1 の outbox の行だけに置く）：

| 項目 | 内容 |
| --- | --- |
| `userId` | 送り主（閲覧者）の ID |
| `category` | 種類 |
| `body` | 検証と正規化のあとの内容 |
| `occurredAt` | 受け付けた時刻（ISO 8601、UTC） |

- Queue のメッセージには payload を載せない（決定事項2。「振る舞い 2.」）。退避キューに残るのは `kind`・`type`・受付番号・`createdAt` だけ。
- メールアドレスは payload に入れず、consumer が送る時に identity から読む（決定事項1）。理由：
  - outbox の行は処理から7日（T-12）、D1 の復元用の記録は最大30日残る。payload にメールアドレスを入れると、その間ずっと同じものが別の場所に残る。
  - 送るまでの間に退会したら、`users.email` は NULL になる（T-16）。送る時に読めば、退会した人のアドレスを Slack に出さない。ログインで Google 側の新しいアドレスに変わっていたら、新しいほうに返信できる（T-01）。
  - `SessionStarted` などほかの型も、payload にメールアドレスを入れていない（T-01 のテスト）。同じ決まりにそろえる。
- 届けたら、その行の payload から `category` と `body` を消し、`{ "userId": ..., "occurredAt": ..., "delivered": true }` にする（決定事項3。「振る舞い 3.」）。`userId` と `occurredAt` は、回数の上限を数えるのと、退会のときに消すために残す。行そのものは今の掃除（処理から7日。T-12）で消える。
- 回数の上限は、この型の outbox の行を数える（「振る舞い 1.」）。インデックスは今の `outbox_type_unprocessed (type, processed_at, created_at)` を使う。`created_at` の範囲には効かないが、数える行はこの型の7日分だけ（友達だけの運用で多くて数十行）なので、新しいインデックスは足さない。

## 振る舞い

### 1. 受け付け（`POST /contact-messages`）
- 検証に通ったら、1つの文で outbox に行を書く。回数の上限と退会の確認を同じ文に入れ、同時に送っても上限を超えない（T-04 の送信上限・T-10 の `ics-links` と同じ書き方）。`?now` は1回の要求で1つの値（`deps.now()` を1回だけ読む）：
  ```sql
  INSERT INTO outbox (id, type, payload, created_at)
  SELECT ?id, 'ContactMessageSubmitted', ?payload, ?now
  WHERE <activeUserExistsSql('?userId')>
    AND (SELECT COUNT(*) FROM outbox
         WHERE type = 'ContactMessageSubmitted'
           AND json_extract(payload, '$.userId') = ?userId
           AND created_at > ?now - 86400000) < 3
  ```
- 回数の上限：1人あたり、直近24時間（受け付けた時刻で数える、ずれていく窓）に3件まで（決めたこと9）。
  - 行が入らなかった（`changes = 0`）ら、まず `getContactSender` で退会したかを直接確かめる。退会していたら401 `unauthenticated`（`requireActiveSession` と同じ答え）。
  - 退会していなければ429 `rate_limited`。`Retry-After` は、同じ `?now` で `SELECT MIN(created_at) ... AND created_at > ?now - 86400000` を読み、その行が24時間を過ぎるまでの秒数（切り上げ。1以上）。同じ `?now` を使うので、文の実行と数え直しの間に24時間の境目をまたいでも、429 と401 を取り違えない。最も古い行が読めない（同時に退会で消えたなど）ときは `Retry-After: 1`。
  - 退会したとき、本人の `ContactMessageSubmitted` の行は消える（「5.」）ので、数からも外れる。
  - Workers の Rate Limiting（おおよその数）は使わない。3件という小さな上限は、厳密に数える必要があるため（T-10「部品の役割」）。
- 成功したら204。画面に出すのは「受け付けた」ことだけ（受付番号は画面に出さない）。
- ログ：受け付けのログは出さない。上限を超えたときは、T-10 の共通の `rate_limited` と同じ形（`{ event: "rate_limited", group: "contact_messages" }`。利用者 ID は出さない）を出す。内容・種類・メールアドレス・利用者 ID はどのログにも出さない。

### 2. outbox から Queues へ（決定事項2）
- `ContactMessageSubmitted` を、dispatch の「常に流す型」（`apps/api/src/jobs/dispatch.ts` の `CALENDAR_TYPES`）に足す。`NOTIFICATION_START_AT` に左右されない。
- 今の `dispatchOnce` は outbox の payload をそのまま Queue のメッセージに入れる。Queue のメッセージは再試行の間と退避キューの4日（T-13）に残り、退会で D1 の行を消しても残る。そのため、この型は payload を載せない：
  - outbox の行から Queue のメッセージを作る関数を1つにする（`toJobMessage(row)`。`dispatchOnce` と E2E の `/__e2e__/outbox/drain` の両方が使う）。`ID_ONLY_TYPES`（今は `ContactMessageSubmitted` だけ）の型は、`payload: "{}"` にする。
  - consumer は、この型では Queue のメッセージの payload を使わず、受付番号で D1 の outbox の行を読む（`deliverContactMessage(ctx, outboxId)`）。
- consumer（`apps/api/src/jobs/consumer.ts` の `handleCalendarSide` の振り分け）で `ContactMessageSubmitted` を `deliverContactMessage(ctx, job.id)` に渡す。`createFromEvent`（通知）は今までどおり空の payload で呼ばれるが、この型の下書きを作らない（`draftsFor` に型がない。実装PRで「お知らせが作られない」ことをテストする）。

### 3. 届ける処理（consumer）
`deliverContactMessage(ctx, outboxId)`。何度呼んでも、Slack に届くのは原則1通（下の「受け入れること」）。

1. D1 の outbox の行を、`id = ?outboxId AND type = 'ContactMessageSubmitted'` で読む。行がない（退会で消えた・掃除で消えた）、または payload に `delivered: true` がある（届け済み）なら、何もせずに終える（ack）。
2. `getContactSender(env, payload.userId)` で、退会していないかと返信先を読む。退会していたら、送らずに payload を「届けた」と同じ形に消して終える（退会した人の内容とアドレスを外に出さない。決定事項5）。
3. Slack に送る文を、domain の関数で組み立てる（「4.」）。
4. webhook の URL を確かめる（`CONTACT_SLACK_WEBHOOK_URL`）：
   - `new URL()` で読めて、`protocol` が `https:`、`hostname` が許す宛先（既定 `hooks.slack.com`）と同じで、`port` が空、`username`・`password` が空、`pathname` が許す接頭辞（既定 `/services/`）で始まること。どれかが違う、値がない、`new URL()` が例外になるときは、送らずに `ContactWebhookNotConfigured` を投げる（設定の誤りで別の宛先に個人情報を送らないため）。
   - 許す宛先と接頭辞は contact の定数（`CONTACT_WEBHOOK_TARGET = { hostname: "hooks.slack.com", pathPrefix: "/services/" }`）。`AppDeps` の `contactWebhookTarget` で差し替えられるが、差し替えるのは `apps/api/src/e2e/entry.ts` の `createWorker(overrides)` だけ（環境変数では切り替えない。T-10 の差し替えと同じ）。
5. `POST` する（`deps.fetch`、`Content-Type: application/json`、`redirect: "manual"`、5秒で打ち切る。T-10 の外部の呼び出しと同じ）。
   - 200 以外は `ContactWebhookRejected` を投げる。3xx（転送）も、転送先へは行かずに失敗にする。Slack の 429 も同じ（Queue の再試行の間隔は30秒から倍々。T-06）。
   - 例外の `message` に、URL・応答の本文・問い合わせの内容・メールアドレスを入れない（consumer の `job_failed`・`job_dead_lettered` のログは例外の `name` だけを出すが、念のため）。
6. 200 なら、行の payload を書き換える。条件付き：`UPDATE outbox SET payload = ?redacted WHERE id = ? AND type = 'ContactMessageSubmitted' AND json_extract(payload, '$.delivered') IS NULL`（`?redacted` は `{ userId, occurredAt, delivered: true }`）。同じ行を同時に処理したもう1つの consumer と書き合っても、結果は同じ。
7. 書き換えのあと、`getContactSender` でもう一度退会していないかを確かめる。2 と 5 の間（最長5秒）に退会していたら、`console.warn(JSON.stringify({ event: "contact_delivered_after_withdrawal", id: <受付番号> }))` を出す（利用者 ID・内容は出さない）。運営者はこのアラートで、その受付番号のメッセージを Slack で消す（「7.」）。
- 失敗したら投げて、Queue の再試行に任せる（`max_retries: 5`）。最後の失敗は退避キューに入り、今の `job_dead_lettered`（`type: "ContactMessageSubmitted"`）の「すぐ見る」アラートで気づく（T-13）。
- やり直し：outbox の行の `processed_at` を NULL に戻す（T-13「8.」のまま）。届かなかった行は payload が残っているので、そのままやり直せる。退避キューのメッセージには内容がないので、見ても調べることはない。
- 受け入れること：
  - Slack が受け取ったあと、6 の書き換えの前に止まると、再試行でもう1通届く。届いた文には受付番号が入るので、運営者は重なりに気づける。
  - 2 の確かめと 5 の送信の間（最長5秒）に退会すると、内容とメールアドレスが Slack に届く。7 のアラートで気づき、手で消す。プライバシー ポリシーにも書く（「8.」の文案）。

### 4. Slack に送る文（決定事項6）
Incoming Webhook の JSON：

```json
{
  "text": "問い合わせ：不具合",
  "unfurl_links": false,
  "unfurl_media": false,
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "問い合わせ：不具合", "emoji": false } },
    { "type": "section", "fields": [
      { "type": "plain_text", "text": "返信先：user@example.com", "emoji": false },
      { "type": "plain_text", "text": "受付：2026-11-23 14:05（日本時間）", "emoji": false },
      { "type": "plain_text", "text": "利用者ID：<UUID>", "emoji": false },
      { "type": "plain_text", "text": "受付番号：<outbox の id>", "emoji": false }
    ] },
    { "type": "section", "text": { "type": "plain_text", "text": "<内容>", "emoji": false } }
  ]
}
```

- 載せるもの：種類（表示の名前）、返信先のメールアドレス、受け付けた時刻（`Asia/Tokyo` で表す。payload の `occurredAt` から）、利用者 ID、受付番号、内容。表示名は載せない（返信と本人の確認には ID とメールアドレスで足りる）。
- 返信先がない（`email` が NULL）ときは「返信先：登録なし」。
- `text`（Slack の通知とスマホの通知の要約に出る）は「問い合わせ：<種類>」だけにし、内容とメールアドレスを入れない。
- 利用者の文が Slack の書式として読まれないようにする：
  - 利用者が書いたもの（内容）と、外から来たもの（メールアドレス）は、`plain_text` の欄にだけ入れる。`mrkdwn` を使わないので、`*太字*`・`<https://...|文字>`・`<!channel>`・`<@U...>`・`<!here>` は書式・リンク・メンションにならない。`"emoji": false` で `:名前:` も絵文字にしない。
  - そのうえで、送るすべての文字列の `&`・`<`・`>` を `&amp;`・`&lt;`・`&gt;` にする（Slack の公式が、書式の制御に使う3つの文字として、エスケープを求めている）。`@channel`・`@here` を文字のまま書いても、Incoming Webhook は `link_names` を付けないかぎりメンションにしない（「人が確かめること」）。
  - `plain_text` の欄でエスケープした `&amp;` が `&` と出るか、`&amp;` のまま出るかは、公式で確かめられていない。人が確かめ、文字のまま出るなら、`plain_text` の欄ではエスケープをやめる（`mrkdwn` を使わないことで足りる）よう、実装PRで仕様書を直す。
  - `unfurl_links`・`unfurl_media` を `false` にし、内容に書かれた URL を Slack が読みに行かない（リンク先に、運営が見たことを知らせない）。
- Slack の上限：`section` の `text` は3000文字、`fields` の各欄は2000文字、`header` は150文字。内容は1000文字（コードポイント）までだが、エスケープで伸び（1文字が最大5文字の `&amp;`）、サロゲートペアは UTF-16 で2つに数えるので、最大で5000文字になり、3000文字を超えうる。ふつうは `section` は1つで、超えたときだけ分ける。分け方：
  - エスケープの前の内容をコードポイントで1つずつ見て、エスケープしたあとの長さ（UTF-16）を足していき、足すと3000を超えるところで次の `section` に移る。分ける位置はコードポイントの境目だけにするので、`&amp;` などの途中と、サロゲートペアの間では切れない。
  - `section` は最大2つ（1000 × 5 ÷ 3000 の切り上げ）。順番は内容の順。
  - 改行の位置を探して分けることはしない（文の途中で切れることは受け入れる）。

### 5. 退会
- T-16 の「入口を止める段」の、outbox の本人だけに関わる行を消す型の一覧に `ContactMessageSubmitted` を足す（処理済み・未処理とも）。まだ届けていない問い合わせも消え、届かない。Queue のメッセージに内容はないので、Queue に残ったメッセージからも届かない。
- consumer に渡ったあとに退会したときは、「3.」の 2 で送らない。2 と 5 の間の退会は「3.」の 7 のとおり。
- 退会の直前に送った「個人情報の開示・削除の請求」も、届ける前に退会すると届かない。退会でアプリのデータは消えるので、削除の請求は退会で満たされる。開示の請求は退会の前に答えを受け取る必要がある。画面の「個人情報の開示・削除の請求」の `Note` に書く（「9.」）。
- 退会の前に Slack に届いたものは、「6.」の期間で消える。プライバシー ポリシーの「退会したとき」に書く。

### 6. 保持期間
| データ | 消す時点 | 値の置き場所 |
| --- | --- | --- |
| outbox の payload の種類・内容 | Slack に届けたとき（届かなかった行は、処理から7日で行ごと消える） | `RETENTION.processedOutboxDays`（今の値） |
| outbox の行（`userId`・`occurredAt`・`delivered` だけ） | 処理から7日（T-12。今の掃除のまま） | `RETENTION.processedOutboxDays` |
| Queue のメッセージ・退避キュー（受付番号だけ。内容・利用者 ID・メールアドレスは入らない） | Queues の保持期間（既定4日。T-13） | `PLATFORM_RETENTION.deadLetterQueueDays` |
| D1 の復元用の記録 | 最大30日（今のまま。#89） | `PLATFORM_RETENTION.databaseRestoreDays` |
| Slack のメッセージ | 運営者が、対応を終えたら手で消す。あわせて、Slack の保持の設定で、投稿から90日で消える（決定事項7） | `PLATFORM_RETENTION.contactSlackDays`（新しい値 `90`） |
| `idempotency_keys`（本文のハッシュと204だけ） | 24時間（T-10） | `RETENTION.idempotencyKeysHours` |

- Slack の保持（決めたこと4、決定事項7）：
  - Slack のヘルプの要約（ページそのものはこの作業環境から開けなかった）によると、無料のプランでは、見られるのは直近90日のメッセージだけで、1年より古いデータは消える（2024年8月26日から）。無料のプランの管理者は、メッセージを90日で消す保持の設定を選べる。
  - 本番の前に、人が `#kokohima-contact`（チャンネルの単位でできなければワークスペース）の保持を「90日を過ぎたら消す」にする（#52 の人の作業、手順書「1-1.」）。プライバシー ポリシーの「遅くとも90日」は、この設定に頼る。
  - 無料のプランでこの設定ができないときは、有料のプラン（チャンネルの単位で90日の保持を設定できる）にするか、ポリシーの日数を直す（「確認事項」）。
  - ワークスペースの保持を90日にすると、監視の2つのチャンネル（T-13）のメッセージも90日で消える。監視の通知は件数と名前だけで、過去の通知を90日より長く残す必要はないので受け入れる。
- `packages/shared/src/retention.ts` の `PLATFORM_RETENTION` に `contactSlackDays: 90`（注記：Slack の保持の設定。人が設定する。変わってもコードでは気づけない）を足す。プライバシー ポリシーの本文は、この値と `RETENTION.processedOutboxDays` から日数を作り、文に数を直書きしない（T-19「9.」）。
- T-17「1. 保持期間の一覧」に、上の表の行を足す（実装PR）。

### 7. 運営者の扱い（手順書）
- `#kokohima-contact` は非公開のチャンネルにし、メンバーは運営者だけにする。メンバーは、アプリ（Incoming Webhook）の投稿を消せる役割（ワークスペースのオーナーか管理者。無料のプランで誰が消せるかは「確認事項」）にする。ワークスペースは2段階認証を必須にする。ゲスト・外のワークスペースとの共有（Slack コネクト）・ほかのアプリの連携を、このチャンネルに入れない。
- 監視の決まり「ログの本文は Slack に流さない」（T-13「4.」、手順書の冒頭）の例外は、このチャンネルだけ。監視の2つのチャンネルには今までどおり流さない。問い合わせの内容を、監視のチャンネル・issue・PR・ほかのチャンネルに貼らない。
- 返信は `ops@kokohima.app` から、Slack に出た返信先に送る。個人情報の開示・削除の請求は、送り主がログインして送ったこと（利用者 ID）で本人と確かめ、登録のメールアドレスにだけ答える（T-19「12.」）。
- 対応を終えたら、Slack のメッセージを消す。保持の設定（「6.」）が効いているかを、月に1回、90日より古いメッセージが残っていないかで確かめる。
- `contact_delivered_after_withdrawal` のアラートが来たら、ログの受付番号のメッセージを Slack で探して消す（返事はしない）。
- webhook の URL は秘密情報。`wrangler secret` にだけ登録し、Cloudflare の通知先（T-13 の webhook）・Better Stack には登録しない。漏れたら Slack 側で作り直し、`wrangler secret put` し直す。

### 8. 設定値・テストの差し替え
- 秘密情報：`CONTACT_SLACK_WEBHOOK_URL`（`Bindings` に足す）。`wrangler secret put CONTACT_SLACK_WEBHOOK_URL --env prod`（staging は別のチャンネルの webhook を入れるか、入れない。「確認事項」）。`.dev.vars` はコミットしない。`apps/api/dev-vars.example` に名前だけを足す。
- ローカル（`pnpm dev`）：値を入れなければ、consumer は `ContactWebhookNotConfigured` で失敗し、ローカルのキューの中で再試行・退避するだけ（本物の Slack には届かない）。届くことを確かめるときは、E2E の偽物を使う。staging で入れないときも同じく退避キューに入る（staging には Monitors がない）。
- E2E：
  - `apps/api/scripts/write-e2e-dev-vars.mjs` が `CONTACT_SLACK_WEBHOOK_URL=https://slack.e2e.invalid/services/e2e` を書く。
  - `apps/api/src/e2e/entry.ts` の `createWorker` に `contactWebhookTarget: { hostname: "slack.e2e.invalid", pathPrefix: "/services/" }` を渡す。
  - `e2eFetch` が `slack.e2e.invalid` への送信を受け、E2E だけの表 `e2e_contact_posts (user_id TEXT NOT NULL, body TEXT NOT NULL)`（本番のマイグレーションに入れない。T-07 の偽のメールと同じ作り）に残す。`user_id` は、送られた JSON の「利用者ID：」の欄から取り出した UUID。
  - 確かめる経路：`GET /__e2e__/contact/posts`（`requireAuth`）。`WHERE user_id = ?閲覧者` の一致で、閲覧者の送信だけを返す（並んで走るテストの送信は返さない）。応答は `{ "posts": [<送られた JSON>, ...] }`。
- 単体テスト：`AppDeps` の `fetch` を差し替え、送った JSON を確かめる。`apps/api/vitest.config.ts` の `miniflare.bindings` に `CONTACT_SLACK_WEBHOOK_URL`（`https://hooks.slack.com/services/TEST/TEST/test` の形の偽の値）を足す。

### 9. 画面（決定事項8）
キャンバスに問い合わせの画面はない。デザインシステムのトークン（`apps/web/src/index.css`）と `apps/web/src/ui/` の部品だけで作る。

#### 入口
- 設定のトップ（`SettingsPage`）の節「このアプリについて」の最初の行に「問い合わせ」（`/settings/contact`）を足す（公開の日から。「11.」）。並びは「問い合わせ」「アプリとして使う」（T-25）「プライバシー ポリシー」「利用規約」。今の `Row` を使う。

#### 画面の枠
- `/settings/contact` は、ほかの設定の画面と同じ `SubScreen`（題「問い合わせ」、`back="/settings"`）。シートにしない：設定の下の画面はどれも `SubScreen` で、シートは誘い・募集などタブの上に重ねる詳細と作成だけ（T-11「画面のつながり」）。
- PC の配置（幅1024px以上）では、`SubScreen` のとおり左のナビを出し、ナビの「設定」に `aria-current="page"` が付く（T-20。`/settings` の下の画面はすべて同じ）。中身は1列のまま、T-20 の中身の幅（`max-w-3xl`）の中に置く。幅で描き分けない。
- `App.tsx` の振り分けに `/settings/contact` を足す。ログインしていなければ、ほかの設定の画面と同じくログインへ（戻り先 `returnTo` は `/settings/contact`）。

#### 中身（上から）
1. 説明（`p`）：「不具合・ご意見・個人情報の求めなどを、運営に送れます。返事が要るものは、ログインに使っているアカウントのメールアドレスにお送りします。」
2. 入力のカード（`rounded-l bg-surface p-4 shadow-card`、中は `flex flex-col gap-4`）：
   - 種類：`ChipRow`（ラベル「種類」）に4つの `Chip`（「不具合」「ご意見」「個人情報の開示・削除の請求」「その他」）。初めはどれも選ばない。1つだけ選べる（選んだものは `aria-pressed="true"`）。
   - 「個人情報の開示・削除の請求」を選んだときだけ、すぐ下に `Note`：「本人の確認のため、返事はログインに使っているアカウントのメールアドレスにだけお送りします。運営に届く前に退会すると、この求めは届きません。アカウントとデータをすべて消すときは、設定の『アカウント』から退会もできます。」
   - 内容：`Field`（ラベル「内容」）の中に `textarea`（新しい `textareaClass`）。高さは8行ぶん、縦にだけ伸ばせる。`maxLength` は付けない（コードポイントで数えるため。超えたら送れなくするだけ）。
   - 文字数：入力欄の下の右に `CharCount`（「123 / 1000」）。数え方は `contactBodySchema` と同じ（正規化して前後の空白を除いたコードポイント。`packages/shared` の `contactBodyLength`）。1000を超えたら「1000文字までです（123文字多い）」の文にする。色は `text-ink-muted` のまま（赤にしない）。`aria-live="polite"` の見えない領域（`sr-only`）に、超えたときだけ同じ文を入れて読み上げる（入力のたびの数は読み上げない）。超えている間は、見えている文に `aria-hidden` を付け、二重に読み上げない。
   - 送り先の説明（`Note`）：「送った内容は、運営の連絡用の Slack（米国の Slack 社のサービス）に届きます。パスワードや、ほかの人の個人情報は書かないでください。くわしくは」＋「プライバシー ポリシー」（`Link` で `/privacy`）。
   - 送るボタン：`SendButton`（「送る」、`block`）。種類が選ばれていない・内容が空・1000文字を超える・送信中・オフラインのときは押せない。
3. オフラインの間は、`SubScreen` のオフラインの帯に加えて、ボタンの下に `Note`「オフラインの間は送れません」（T-11「オフライン」）。

#### 送ったあと（静かな成功）
- 入力のカードを、同じ大きさのカードの確認に置き換える（`role="status"`）：見出し「送りました」と、「受け付けました。返事が要るものは、メールでお返しします。」。下に `ButtonLink`（`variant="ghost"`、「設定に戻る」→ `/settings`）。`Toast` は使わない（消えると、送れたか分からなくなるため）。
- 成功の色（成立の `meet`）も使わない。ふつうの面と文字のトークンだけ。
- 同じ画面で続けて送るボタンは出さない（もう一度送るときは、設定から開き直す）。

#### 送れなかったとき（静かな失敗）
- 入力した内容と種類は残す。ボタンの上に `p`（`role="status"`、`text-ink-muted`）で出す。赤・エラー色・警告の印を使わない（CLAUDE.md）。

  | 応答 | 文言 |
  | --- | --- |
  | 通信できない・5xx・409 `request_in_progress`・422 `idempotency_key_mismatch`・404（端末の時刻がずれて公開の前に開いたとき） | 「送れませんでした。もう一度お試しください。」（T-10「Web」の「もう一度お試しください」の扱い） |
  | 429 `rate_limited` | 「今日はこれ以上送れません。時間をおいて、もう一度お試しください。」 |
  | 400 `validation_failed` | 「送れませんでした。内容を確かめてください。」（画面の検証を通っているので、ふつうは出ない） |
  | 401 | 今の API クライアントのまま（1回だけ取り直して送り直し、だめならログアウトの状態。T-01）。画面に文言は足さない |
- 冪等キー：`useIdempotencyKey`（T-10）。通信できない・5xx のあと、内容を変えずにもう一度押したら同じキー。4xx（409・422 を含む）・内容や種類の変更・成功のあとは新しいキー。401 のあとの1回だけの送り直しは同じキー（T-10）。
- 送信は TanStack Query の `useMutation` と `apiSend`（`data-fetching` スキル）。応答に本文がないので、無効にするクエリはない。楽観的更新はしない（送れたかを、サーバーの応答で決めてから出す）。
- 書きかけの内容を `localStorage`・`sessionStorage` に残さない（個人情報を含みうるため。画面を離れたら消える）。

#### 新しい部品（`apps/web/src/ui/form.tsx`）
- `textareaClass`：`inputClass` に複数行の分（`py-2`・`min-h-40`・`resize-y`・`leading-normal`）を足したもの。`inputClass` の `min-w-0`・`max-w-full` を含むので、シート・画面の幅をはみ出さない。今のひとことの `textarea`（`InviteNewPage`・`BroadcastNewPage`）は、この実装PRでは変えない（仕様書にない振る舞いを変えないため。そろえるのは別のタスク）。
- `CharCount({ count, max })`：「count / max」と、超えたときの文。`text-xs text-ink-muted tabular-nums`、右寄せ。ほかの長い入力（ひとことなど）でも使える形にする。
- T-11「共通の部品」に、この2つを足す（実装PR）。

### 10. プライバシー ポリシーの改定（決定事項9）
- 集める情報（問い合わせの種類と内容）と委託先（Slack）が増えるので、T-19「8. 改定のしかた」の「大事な変更」にあたる。
- T-19「9.」と PR テンプレートのとおり、`/privacy` の本文と `retention.ts` は、この実装PRで一緒に直す（T-19 の別の PR に回さない）。
- 改定の手順は、T-19 の改定の仕様書PR（ブランチ `spec/T-19-art28`）が決めた手順に従う：改定日の行「改定日（効力が生じる日）：<公表日の7日後>」（`REVISION_DATE_LINE`）、予告の行「公表日：<デプロイの日>（この版は改定日から適用します。それまでは、前の版を適用します）」（`REVISION_NOTICE_LINE`）、改定日を過ぎたら予告の行を外す PR、デプロイの日の確かめ（#52）。T-19 の改定の手順に「この改定で変わるところ」の一覧があれば、この改定の項目（下の文案の見出し）を載せる。
- 問い合わせの機能そのものは、改定日（効力が生じる日）より前に使えるようにしない。実装は先にデプロイし、改定日から入口と受け付けを始める（決めたこと10。仕組みは「11.」）。
- T-19 の改定（`spec/T-19-art28`）と、この改定のどちらが先に main に入るかで、本文の土台が変わる。後に入るほうが、先に入った文に重ねて直す。
- 本文の直し（文案の要点。日数は `retention.ts` から作る）：
  - 「2. 預かる情報」の「あなたが入力するもの」：問い合わせの種類と内容。送るときに、ログインのメールアドレスと利用者を区別する番号を一緒に運営に届けること。
  - 「3. 使う目的」：8（問い合わせに答える）は今のまま使う。7（障害に気づいて直す）に「問い合わせで知らせてもらった不具合を直すため」を足し、新しい目的9「問い合わせでもらったご意見をもとに、このサービスを良くするため」を足す（今の本文に改善の目的がないため）。直後の「メールアドレスは、5.・8.・『12.』にだけ使います」に、問い合わせに答えるため、返信先として運営の連絡用の Slack に届けることを足す。
  - 「5. 委託」：「Slack Technologies, LLC（米国）」の項目。任せること＝問い合わせを運営者に届けて保管する。渡すもの＝問い合わせの種類・内容・受け付けた時刻・利用者を区別する番号・返信先のメールアドレス。監視の項目（障害の知らせ）は今の文のまま、問い合わせとは別の項目にする。
  - 「7. 外国の事業者に任せるとき」（T-19 の改定のあとの節）：Slack を、相当措置をとる外国の事業者として足す（体制の確かめ方：Slack のデータ処理に関する契約（DPA）。中身は T-19 の確認事項（b）4 と同じく、デプロイの前に人が確かめる）。T-19 の改定の文の「障害の知らせ（Slack）…は、利用者の情報を渡さない使い方にしているので、ここには含めません」は、監視の通知に限った文に直す。
  - 「8. 保存する期間」：「問い合わせ：運営に届けたら、このサービスのデータベースから内容を消します。うまく届かなかったものは、処理の記録として{processedOutboxDays}日で消えます。運営の連絡用の Slack に届いたものは、対応を終えたら消し、遅くとも Slack に届いてから{contactSlackDays}日で消えます。」（Slack の保持は投稿から数えるので、受け付けからでなく Slack に届いてから数える）
  - 「8.」の「退会したとき」：まだ運営に届いていない問い合わせは届けずに消すこと。退会とほぼ同時（数秒のうち）に届いたものと、退会の前に届いたものは、上の期間で消えること（運営が気づいたものは、その時点で消すこと）。
  - 「12. 開示・訂正・削除などの求め」：ログインしているなら、アプリの「設定 → 問い合わせ」（種類「個人情報の開示・削除の請求」）からも求められ、登録のメールアドレスに答えること。
  - T-19「9.」の、本文を直すタスクの並びに T-24（問い合わせ）を足す。

### 11. 公開の日（決めたこと10）
- `packages/shared/src/contactStart.json` に `{ "startDate": "YYYY-MM-DD" }`（または未定の間は `null`）を置く。API・画面（TypeScript）と、デプロイの検査（`apps/api/scripts/lib/effective-date.mjs`。node の `.mjs` から TypeScript を読まないので JSON にする）が同じ値を読む。
  - 値は、プライバシー ポリシーの改定日（`REVISION_DATE_LINE` の日付）と同じ日。T-19 の改定（PR #146）と同じ週にデプロイするなら、改定日・公表日の行を1つにまとめ、1回の予告で両方の改定を知らせる（「この改定で変わるところ」に両方を載せる）。
  - `packages/shared` の `contactStartAt(): number | null`：`startDate` の `Asia/Tokyo` の0時（`YYYY-MM-DDT00:00:00+09:00`）を Unix ミリ秒で返す。`null` なら `null`（いつまでも閉じたまま）。`isContactOpen(now, startAt)`：`startAt !== null && now >= startAt`。
- API：`POST /contact-messages` の最初（`requireAuth` より前）で `isContactOpen(deps.now(), deps.contactStartAt)` を見て、閉じていれば知らない経路と同じ404（`app.notFound` と同じ本文。ログも同じ）。outbox に行はできない。`AppDeps.contactStartAt`（既定は `contactStartAt()`）を、E2E のエントリ（`apps/api/src/e2e/entry.ts`）だけが `0` に差し替える。consumer・dispatch は公開の日を見ない（閉じている間は行ができないため）。
- 画面：端末の時刻（`Date.now()`）で `isContactOpen` を見て、閉じていれば設定のトップの「問い合わせ」の行を出さず、`/settings/contact` は `App.tsx` の振り分けで知らない経路と同じ扱い（みんなのタブ）にする。端末の時刻がずれて早く出ても、API が404 を返すので受け付けない（画面は「送れませんでした。もう一度お試しください。」）。E2E の画面（`E2E=1` の vite）だけは開いた扱いにする（`apps/web/vite.config.ts` の `define` で `__CONTACT_FORCE_OPEN__` を `process.env.E2E === "1"` にする。本番のビルドでは `false`）。
- デプロイの検査（`effective-date.mjs` の `contactStartProblems`。`check-web-dist.mjs` が `contactStart.json` を読んで渡す。T-19 の改定の仕様書の5節）に足す：デプロイの日（日本時間の今日）が `startDate` より前なら、ビルドの出力の「改定日（効力が生じる日）：」の日付が `startDate` と同じで、予告の行（「公表日：」）が1つあること。違えば止める。`startDate` が今日以前、または `null` なら条件を足さない。`startDate` は、`null` か暦にある日付でなければ、いつもの検査（`check:release`）で止める。
- 改定日を過ぎたあとも、`startDate` と判定は残してよい（害がない）。T-19 の「予告の行を外す PR」で消してもよい（任意）。

## 認可と秘匿
- 閲覧者IDの使い方：送り主は、いつもアクセストークンの閲覧者。本文で送り主を指定できない（`.strict()`）。outbox の行の `userId` も閲覧者で、consumer はその ID のメールアドレスだけを読む。
- 他人のデータに届かないことの保証：読み取りの経路がない。応答は204で、ほかの人の情報も、自分の問い合わせの中身も返さない。Slack に出るメールアドレスは、送り主本人のもの（consumer が outbox の `userId` で読む）。利用者 A が B の ID を本文に入れても、送り主は A のまま。E2E の確かめる経路も、閲覧者の `user_id` の一致だけを返す。
- 区別させない応答：ほかの利用者に関わる応答の差はない。429 は本人の送った数だけで決まる。
- 秘匿：
  - ログ：内容・種類・メールアドレス・利用者 ID・webhook の URL を出さない。consumer の失敗のログは今の `job_failed`・`job_dead_lettered`（`kind`・`type`・`id`・`attempts`・`error` の名前）だけ。`contact_delivered_after_withdrawal` は受付番号だけ。
  - payload にメールアドレスを入れない。Queue のメッセージ（再試行・退避キュー）に payload を載せない。届けたら D1 の内容も消す。
  - 本文の上限を冪等キーの処理より前に確かめ、大きな本文を読まない・残さない。
  - Slack の文：利用者の文は `plain_text` に入れ、`&`・`<`・`>` をエスケープし、メンション・リンク・書式・リンクの展開を起こさせない。スマホの通知の要約に内容を出さない。
  - webhook の URL は `wrangler secret` だけ。送る前に `new URL()` で宛先と接頭辞を確かめ、転送に従わない（設定の誤りや転送で、ほかの宛先に送らない）。
  - 退会した人の問い合わせは、まだ届けていなければ届けない。送信と重なった数秒の間に届いたものは、アラートで気づいて手で消す。
- 悪用：Slack への大量の投稿は、1人24時間に3件と本文の上限で抑える。利用者は友達の招待でしか増えない（T-02）。全体の上限は付けない（スコープ外）。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] 正常系：ログインした A が送ると204で、outbox に `ContactMessageSubmitted` の行が1つだけでき、payload が `userId`（A）・`category`・`body`（正規化のあと）・`occurredAt` だけで、メールアドレスを含まない
- [x] 入力検証（`packages/shared` のスキーマ）：知らない項目（`userId`・`email` を含む）、一覧にない `category`、`body` がない・数値は400。`body` の正規化（`\r\n`・`\r` → `\n`、タブ → 空白、NFC、前後の空白）。制御文字・孤立サロゲート・書字方向を変える文字は `invalid_characters`、改行・絵文字をつなぐ文字（U+200D）は通る
- [x] 境界値：`body` が空・空白だけは `too_short`、1000文字（4バイトの文字・サロゲートペアで作る）は通り、1001文字は `too_long`。生の文字列が8000文字（UTF-16）は正規化まで進み、8001文字は `too_long`
- [x] 本文の上限：ちょうど8192バイトは検証まで進み、8193バイトは400（`Content-Length` がない・偽りでも、読み込んだ長さで400）。8193バイトに `Idempotency-Key` を付けても400で、`idempotency_keys` に行ができない（上限が `idempotent` より前）
- [x] 認証：アクセストークンがない・不正なら401で、outbox に行ができない。`Origin` が違う・ないと401
- [x] 退会：退会した利用者のアクセストークン（期限内）は401で、行ができない。受け付けの文の直前に `withdrawn_at` を入れると401（429 にならない）
- [x] 送り主を偽れない（「他人のIDでは取得・更新できない」）：A のトークンで、本文に B の `userId` を入れると400。正しい本文で送ると、行の `userId` は A で、consumer は A のメールアドレスを Slack に出し、B のアドレスは出ない
- [x] 回数の上限：24時間に3件まで。4件目は429・`Retry-After` が最も古い行が24時間を過ぎるまでの秒数（1以上）。ちょうど24時間前の行は数えない（24時間を過ぎたら4件目が通る）。最も古い行がちょうど境目にあるとき（`?now` を境目に置く）も、429 と401 を取り違えない。B の送った数は A の上限に影響しない。同時に4件送っても3件しか入らない。上限を超えたときのログは `rate_limited` と `group` だけ
- [x] 冪等：同じ `Idempotency-Key`・同じ本文の再送は204で、outbox の行は1つ（Slack にも1通）。違う本文なら422。`idempotency_keys` に内容が入らない
- [x] 書き込みが1つの文：上限の判定と行の書き込みが分かれていない（同時の送信のテストで確かめる）。contact の infra が `users` を直接書かず、identity の `activeUserExistsSql` を使う
- [x] dispatch：この型の行から作った Queue のメッセージ（`dispatchOnce` と `/__e2e__/outbox/drain` の両方。`toJobMessage`）の payload が `"{}"` で、内容・種類・利用者 ID・メールアドレスを含まない。ほかの型のメッセージは今までどおり payload を持つ。`NOTIFICATION_START_AT` が未設定でもこの型を流す
- [x] consumer は D1 の行を読む：Queue のメッセージの payload に偽の内容を入れても、D1 の行の内容を送る
- [x] consumer：偽の Slack に1回だけ `POST` し、`redirect: "manual"`、`text` が「問い合わせ：<種類>」だけ、`blocks` に種類・返信先（A の登録のメールアドレス）・日本時間の受付・利用者 ID・受付番号・内容が入り、`unfurl_links`・`unfurl_media` が `false`、利用者の文の欄がすべて `plain_text`・`emoji: false`
- [x] consumer のエスケープ：内容に `<!channel>`・`<!here>`・`<@U123>`・`<https://example.com|押して>`・`&`・`@channel` を入れると、送る JSON では `&lt;!channel&gt;`・`&amp;` などになり、`<`・`>` がそのまま残らない。メールアドレスの欄も同じ
- [x] `section` の分け方：ふつうの内容は `section` が1つ。エスケープで3000文字を超える内容（`&` を1000個、`&` と絵文字（サロゲートペア）を混ぜたもの）が2つに分かれ、どの `section` も3000文字以下で、`&amp;` の途中とサロゲートペアの間で切れず、つなぐと元の内容のエスケープと同じ
- [x] consumer：返信先がない（`email` が NULL）と「返信先：登録なし」
- [x] consumer：届けたら payload が `userId`・`occurredAt`・`delivered` だけになる。同じメッセージをもう一度処理しても送らない。書き換えは `delivered` がない行だけ（先に書き換えた行を上書きしない）。行がない・届け済みなら送らずに終える
- [x] consumer の退会：送る前に退会していたら、送らずに payload の内容を消す。送ったあとに退会していたら（2 と 5 の間に `withdrawn_at` を入れる）、`contact_delivered_after_withdrawal` が受付番号だけで warn で出る
- [x] consumer の失敗：200 以外・3xx・Slack の 429・通信の失敗・5秒の打ち切りで投げ、payload は残る。URL が未設定・`new URL()` で読めない・`http:`・ホストが違う（`hooks.slack.com.example.com` など）・ポート付き・`/services/` で始まらないと送らずに投げる。最後の試行で `job_dead_lettered`（`type: "ContactMessageSubmitted"`）が warn で出る
- [x] 許す宛先：既定は `hooks.slack.com`・`/services/`。`AppDeps.contactWebhookTarget` で差し替えられ、本番のエントリでは差し替えていない
- [x] ログに出ない：受け付け・上限・consumer の成功と失敗のどの場合も、`console` の全出力に内容・メールアドレス・利用者 ID・webhook の URL が含まれない（内容とアドレスに見分けやすい文字列を入れて確かめる）。例外の `message` にも入らない
- [x] お知らせを作らない：この型の行を流しても `notifications` に行ができない
- [x] 退会：入口を止める段で、本人の `ContactMessageSubmitted` の行（処理済み・未処理とも）が消え、相手（ほかの利用者）の行は残る
- [x] E2E の確かめる経路（`apps/api/src/e2e/` のテスト）：`GET /__e2e__/contact/posts` は閲覧者の `user_id` の送信だけを返し、B の送信は A に返らない。E2E のエントリでないと404
- [x] 公開の日（API）：`contactStartAt` より前は、正しいトークンと本文でも404 `not_found`（知らない経路と同じ本文）で、outbox に行ができず、認証より前に返す（トークンなしでも同じ404）。ちょうど `contactStartAt`（日本時間の0時）からは受け付ける。`startDate` が `null` ならいつも404
- [x] 公開の日（`packages/shared`）：`contactStartAt` が `startDate` の日本時間の0時。`isContactOpen` の境目（1ミリ秒前は閉じ、ちょうどは開く）
- [x] 公開の日（Web）：前は設定のトップに「問い合わせ」の行がなく、`/settings/contact` はみんなのタブになる。当日からは行が出て、画面が開く。E2E の画面（`__CONTACT_FORCE_OPEN__`）では開く
- [x] 公開の日（デプロイの検査。`apps/api/test/effective-date.test.ts`）：今日が `startDate` より前で、改定日の行の日付が `startDate` と違う・予告の行がないと止まり、同じなら通る。今日が `startDate` 以後・`null` なら条件を見ない。`startDate` が暦にない日付・形の違う文字列なら止まる
- [x] 保存期間（`packages/shared/src/retention.test.ts`）：`PLATFORM_RETENTION.contactSlackDays` が90。T-17 の表と同じ
- [x] プライバシー ポリシー（`apps/web/src/pages/legal.test.tsx`）：「2.」に問い合わせの種類と内容、「3.」に改善の目的9とメールアドレスの使い道、「5.」に Slack Technologies, LLC（米国）と渡すもの、「7.」に Slack、「8.」に問い合わせの保存期間（`retention.ts` の値から作った日数）と退会のときの扱い、「12.」に設定の問い合わせから求められること。改定日の行と予告の行（T-19 の改定の手順）
- [x] Web：設定のトップの「このアプリについて」の最初の行に「問い合わせ」があり、`/settings/contact` に移る。`/settings/contact` は `SubScreen`（題「問い合わせ」、戻るで `/settings`）。PC の配置では左のナビの「設定」に `aria-current="page"` が付く。ログインしていなければログインへ移り、戻り先が `/settings/contact`
- [x] Web：種類を選ばない・内容が空・1000文字を超えるときは「送る」を押せない。文字数の表示が正規化のあとのコードポイントで数え、超えたら超えた数の文になる。色の指定に赤・エラー色（Tailwind の既定の色を含む）がない
- [x] Web：「個人情報の開示・削除の請求」を選んだときだけ、本人の確認・退会の前に届かないこと・退会の `Note` が出る
- [x] Web：送ると `POST /api/v1/contact-messages` に `category`・`body` と `Idempotency-Key` が付き、204で「送りました」の確認（`role="status"`）に置き換わる。入力欄は消える
- [x] Web：429・5xx・通信できない・400・409 `request_in_progress`・422 `idempotency_key_mismatch` で、それぞれの文言が静かに出て、入力が残る。通信できない・5xx のあとに同じ内容で押すと同じキー、409・422 のあと・内容を変えたあとは新しいキー。401 は1回だけ取り直して同じキーで送り直し、だめならログアウトの状態（文言は足さない）
- [x] Web：オフラインでは押せず、「オフラインの間は送れません」が出る
- [x] Web：書きかけの内容を `localStorage`・`sessionStorage` に書かない
- [x] Web の部品：`CharCount` が「count / max」と、超えたときの文を出す。`textareaClass` が `inputClass` の幅の指定（`min-w-0`・`max-w-full`）を含む

### E2Eテスト（対象にする利用者の流れ）
- [x] ログインした人が、友達タブ → 設定 → 「問い合わせ」で、種類「不具合」を選び、内容（`<!channel> & テスト` を含む）を書いて送ると、「送りました」が出る。`/__e2e__/outbox/drain` のあと、`GET /__e2e__/contact/posts` で、その人の送信が1通だけあり、内容がエスケープされている（`<!channel>` がそのまま入っていない）。`e2e/contact.spec.ts`。今の `mobile` の設定でも回る（T-20）。E2E では、API の `contactStartAt` を `0` に、画面の `__CONTACT_FORCE_OPEN__` を `true` にして、公開の日によらずに回す（「振る舞い 11.」）
- [ ] このテストに `@iphone` を付け、WebKit（iPhone の端末の設定）でも回す（決定事項10。docs/specs/T-21-webkit-e2e.md「WebKit で回すテスト」の表に足す）。複数行の入力欄・チップ・画面の幅のはみ出しが iPhone の Safari で崩れないかを見るため
- 回数の上限・失敗の文言・退会は単体テストで確かめる（6回送る流れは E2E にしない）。

### 人が確かめること（本番で設定するとき。手順書と #52 に書く）
- Slack の保持の設定：無料のプランで、`#kokohima-contact`（できなければワークスペース）の保持を「90日を過ぎたら消す」にできること、設定したこと。できなければ、有料のプランにするか、仕様書とポリシーの日数を直す。
- 誰がアプリ（Incoming Webhook）の投稿を消せるか（オーナー・管理者だけか、メンバーもか）。運営者がその役割にあること。
- `#kokohima-contact` に、staging か本番で自分のアカウントから1通送り、届いた文を見る：
  - `&`・`<`・`>` が文字どおりに出る（`&amp;` などのまま出たら、「4.」のとおり仕様を直す）。
  - `<!channel>`・`@channel`・`@here`・`<@自分のID>`・`<https://example.com|押して>`・`*太字*`・`:smile:` が、メンション・リンク・書式・絵文字にならない。
  - URL を書いても、リンクの展開（プレビュー）が出ない。
  - Slack のスマホの通知に、内容とメールアドレスが出ない。
  - 運営者の役割で、そのメッセージを消せる。
- チャンネルが非公開で、メンバーが運営者だけであること。
- Slack の事業者の契約（DPA）の中身（T-19 の確認事項（b）4 と同じ）。

## 実装PRで直すもの
- 要求定義書（`docs/requirements.md`）：
  - 「機能要件」に F-22 問い合わせ（ログインした人が設定から、種類を選んで送る。運営者だけの Slack の非公開のチャンネルに届く。1人直近24時間で3件まで、内容は1000文字まで。プライバシー ポリシーの改定日から使える。docs/specs/T-24-contact.md）。
  - 「ドメイン設計（DDD）」のコンテキストの表に `Contact`（汎用。問い合わせ、Slack への受け渡し）。イベントの表に `ContactMessageSubmitted`（Contact。Slack の問い合わせのチャンネルに届ける。Queue のメッセージは受付番号だけ）。
  - 「非機能要件とアーキテクチャ」の構成図に、queue の処理から Slack（問い合わせ）への線。
  - 「悪用対策と運用」に「問い合わせ：1人直近24時間で3件まで」。
  - 「テスト環境の認証」の外部サービスの並び（偽の実装に差し替えるもの）に Slack（問い合わせ）。
  - （前の版で書いた「技術の選定」の外部の連携の行はないので、技術選定の表は変えない。）
- CLAUDE.md：「アーキテクチャ」のコンテキストの一覧に `contact`。
- `invitation-domain` スキル：用語表に「問い合わせ | ContactMessage」「受付番号 | receiptId（outbox の id。T-13 の問い合わせ番号 requestId とは別）」。ドメインイベントの表に `ContactMessageSubmitted`（Slack の問い合わせのチャンネルに届ける。T-24）。
- `e2e-testing` スキル：「外部サービス」の偽の実装に差し替えるものの並びに、Slack（問い合わせ。`slack.e2e.invalid`）。
- `api-conventions` スキル：「成功時のステータス」に「作ったものを読む経路がない作成（問い合わせ・画面のエラーの報告）は204」の1行（提案。合意できなければ、この仕様書の例外のままにする）。
- T-10：「`Idempotency-Key` を受け付ける経路」に `POST /contact-messages`（本文の上限を `idempotent` より前に置くこと）。「回数の上限を付ける経路」の表に `POST /contact-messages`（利用者 ID、直近24時間で3件（厳密）、D1（outbox の行の数）、429 `rate_limited`）と、`Retry-After` の決め方。
- T-12 リリース：本番の秘密の一覧（人が行う作業の `wrangler secret put --env prod`）に `CONTACT_SLACK_WEBHOOK_URL`。
- T-13：「4. アラートの一覧」の Slack のチャンネルの説明に、`#kokohima-contact` は監視の通知先ではなく、ログの本文を流さない決まりの例外であること。「気づけばよい」に `contact_delivered_after_withdrawal`（1件以上）。「8. 退避キューの調べ方」に、`ContactMessageSubmitted` のメッセージは受付番号だけで、やり直しは outbox の行からであること。「10. ログを見られる人の範囲」に、このチャンネルも運営者だけ。
- 手順書（`docs/runbooks/monitoring.md`）：
  - 冒頭の「ログの本文は Slack に流さない」に、例外は `#kokohima-contact` だけ（問い合わせの内容とメールアドレスが入る）と足す。
  - 「1-1. Slack」：手順1を「非公開のチャンネルを3つ」にし、`#kokohima-contact`（運営者だけ・投稿を消せる役割・通知はオン・ゲストと Slack コネクトなし・保持を90日に）を足す。手順2の「次の2か所にだけ登録する」は監視の2つのチャンネルの webhook のことと書き分け、`#kokohima-contact` の webhook は `wrangler secret`（`CONTACT_SLACK_WEBHOOK_URL`）にだけ登録し、Cloudflare の通知先・Better Stack には登録しないこと。漏れたときの作り直し。
  - 「1-3. Monitors」の「気づけばよい」の表に `contact_delivered_after_withdrawal`（`"event":"contact_delivered_after_withdrawal"`、1時間に1件以上）。
  - 「2. アラートごとの最初の対応」：`job_dead_lettered` で `type` が `ContactMessageSubmitted` のとき（webhook の作り直し・チャンネルの削除・URL の設定を疑う。直したら outbox の `processed_at` を NULL に戻す）。`contact_delivered_after_withdrawal` のとき（受付番号のメッセージを Slack で消す）。
  - 新しい節「問い合わせの受け方」：「振る舞い 7.」（返信、開示・削除の請求の本人の確認、対応を終えたら消す、保持の設定と月に1回の確かめ、ほかの場所に貼らない）と「人が確かめること」。
  - 今の「4. 問い合わせの調べ方」（友達から聞いた不具合のログの引き方）は、名前が重なるので「4. 不具合の知らせの調べ方」にし、フォームで届いた不具合も、受付の時刻（Slack の「受付」）からその時間帯のログを引くことを足す（API の要求のログには受付番号も利用者 ID も出ないので、受付番号では引けない。届けるのに失敗したときの `job_failed` には受付番号が `id` として出る）。
  - 「5. ログを見られる人」の表に、`#kokohima-contact`（開発者本人・非公開のチャンネル・投稿を消せる役割）。
- T-16：入口を止める段の outbox を消す型の一覧に `ContactMessageSubmitted`。
- T-17：「1. 保持期間の一覧」に「振る舞い 6.」の行。
- T-18：`clientErrorReportSchema` の `route` の一覧に `/settings/contact`（T-18 が先に main に入っていたら、この実装PRで `packages/shared` も直す。後なら T-18 の実装PRで足す）。
- T-19：「振る舞い 10.」の本文の直し（この実装PRで `PrivacyPage.tsx`・`legal.ts`・`legal.test.tsx` を直す）。仕様書の6節の文案と変更履歴、「9.」のタスクの並びに T-24。
- T-21（WebKit の E2E）：「WebKit で回すテスト」の表に `e2e/contact.spec.ts` の問い合わせの流れ。
- T-11：「共通の部品」に `textareaClass`・`CharCount`（`ui/form.tsx`）。「画面のつながり」の設定の表に `/settings/contact`（問い合わせ。新しい画面。設定のトップの「このアプリについて」から開く）。「画面ごとの置き換え」の表に「キャンバスなし（26 問い合わせ）| `ContactPage`」。
- T-20：「E2E」の、PC で横にはみ出さない主な画面の一覧に、問い合わせを足すか（任意。足すなら同じPRでテストも）。
- `docs/design/README.md`：「画面一覧」の「設定」の行に「問い合わせ（種類と内容、送ったあとの確認）」。画面の数（約22画面）を直す。
- `docs/design/claude-design-prompts.md`：「## 設定」に「26. 問い合わせ：種類（4つのチップ）・内容（複数行と文字数）・Slack に届くことの説明、送ったあとの静かな確認、送れなかったときの静かな文言。個人情報の請求を選んだときの説明」（24・25 は使用中）。キャンバス（MVP画面）への追加は、人が Claude Design で行う（「確認事項」）。
- `packages/shared/src/contactStart.json`（公開の日）、`apps/api/scripts/lib/effective-date.mjs`・`effective-date.d.mts`（`--deploy` の公開の日の条件）、`apps/web/vite.config.ts`（`__CONTACT_FORCE_OPEN__`）と `vite-env.d.ts`・Vitest の設定の定義。T-19 の改定の仕様書の5節（デプロイの検査）に、公開の日の条件を1行。
- `packages/shared/src/retention.ts`：`PLATFORM_RETENTION.contactSlackDays: 90`。`retention.test.ts` の期待。
- `apps/api/wrangler.jsonc`：先頭の秘密情報の一覧のコメントに `CONTACT_SLACK_WEBHOOK_URL`。
- `apps/api/vitest.config.ts`：`miniflare.bindings` に `CONTACT_SLACK_WEBHOOK_URL`（偽の値）。
- `apps/api/dev-vars.example` と `apps/api/scripts/write-e2e-dev-vars.mjs`：`CONTACT_SLACK_WEBHOOK_URL`。
- issue #52 の本文（人が行う作業。コーディネーターが直す）：Slack の保持の設定（90日）、投稿を消せる役割、`#kokohima-contact` と webhook、`wrangler secret put CONTACT_SLACK_WEBHOOK_URL --env prod`、「人が確かめること」の Slack の表示、改定の公表日と改定日。

## スコープ外
- ログインしていない人のフォーム（`ops@kokohima.app` のメールのまま）。
- 利用者への自動の返信メール、送った問い合わせの一覧・履歴の画面、運営者が画面から返事をする機能。
- ファイル・スクリーンショットの添付。
- 問い合わせを D1 に残す仕組み、集計、Slack 以外の届け先（メール・チケットの管理）。
- 画面のエラーの情報（T-18）や端末の情報を問い合わせに自動で付けること。
- 全体（全員あわせて）の回数の上限。
- Slack のメッセージを API で自動で消す仕組み（保持の設定と手で消すことに任せる）。
- 今のひとことの入力欄を `textareaClass`・`CharCount` にそろえること（別のタスク）。

## 決定事項（仕様書PRのレビューで合意する）
1. 返信先のメールアドレスは payload に入れず、consumer が送る時に identity（`getContactSender`）から読む（「データ」の理由）。（提案）
2. 内容は D1 の outbox の行にだけ置き、Queue のメッセージ（再試行・退避キュー）には受付番号だけを載せる。consumer は D1 の行を読む。（提案。セキュリティのレビュー）
3. 届けたら outbox の payload から種類と内容を消す（条件付きの UPDATE）。届かなかった行は、やり直せるように残す（処理から7日で消える）。（提案）
4. 回数の上限（1人直近24時間に3件。決めたこと9）は、outbox の行を1つの文で数える（新しい表を作らない）。本文の上限は8KiB・生の文字列は8000文字で、本文の上限は冪等キーの処理より前に確かめる。（提案）
5. 送る前に退会していたら届けない。退会で未処理の行も消す。送信と重なった数秒の退会はアラートで気づいて手で消す。（提案）
6. Slack の文は Block Kit の `plain_text` だけで組み、`&`・`<`・`>` をエスケープし、リンクの展開を止め、通知の要約に内容を出さない。webhook の URL は `new URL()` で宛先を確かめ、転送に従わない。（提案）
7. Slack のメッセージは、運営者が対応を終えたら手で消し、Slack の保持の設定で90日で消える。プライバシー ポリシーには「遅くとも Slack に届いてから90日」と書く（`PLATFORM_RETENTION.contactSlackDays`）。（決めたこと4にもとづく提案）
8. 画面：入口（決めたこと5）は「このアプリについて」の最初の行。`/settings/contact` の `SubScreen`。種類（決めたこと6）はチップ、内容は複数行の入力欄と文字数。成功は同じ場所の静かな確認、失敗は静かな文言。新しい部品 `textareaClass`・`CharCount` を `apps/web/src/ui/form.tsx` に置く。（提案）
9. プライバシー ポリシーは T-19 の改定の手順（7日前の予告）で、この実装PRで直す。公開の日は `packages/shared/src/contactStart.json` の1つの値で、API は前なら404、画面は入口を出さない。デプロイの検査で改定日と同じことを確かめる（決めたこと10）。（提案）
10. E2E の問い合わせの流れは WebKit（`@iphone`）でも回す。（提案）

## 確認事項（合意前に解消する）
- Slack の保持（決めたこと4）：
  1. 無料のプランで、メッセージを90日で消す保持の設定が本当にできるか（チャンネルの単位か、ワークスペースの単位か）。できなければ、有料のプラン（チャンネルの単位で90日）にするか、ポリシーの日数を直すか。
  2. 無料のプランで、アプリ（Incoming Webhook）の投稿を誰が消せるか（オーナー・管理者だけか）。
  3. ワークスペースの単位で90日にすると、監視のチャンネルの通知も90日で消える。それでよいか（提案：よい）。
- Slack の事業者の契約（DPA）と、外国の事業者に任せるときの相当措置（T-19 の改定）に Slack を入れてよいか。契約の中身は、T-19 の確認事項（b）4 と同じく、デプロイの前に人が確かめる。
- staging に `#kokohima-contact` と別のチャンネルの webhook を入れるか（入れないと、staging の問い合わせは退避キューに入るだけ）。
- キャンバス（MVP画面。docs/design/README.md）に「26 問い合わせ」を足すか。足すなら、実装の前に人が Claude Design で作る。足さないなら、この仕様書の「9.」とトークン・部品で作る。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書き | 利用者の依頼（ログインした人だけ、Slack に届ける、種類を選ぶ）。入口・種類の4つ・専用のチャンネル・自動の返信をしないことは、この仕様書からの提案 |
| 2026-11-23 | 番号を T-24（要件は F-22）にした | T-21〜T-23 がほかのタスクで使われているため |
| 2026-11-23 | 本文の上限を `idempotent` より前に。Queue のメッセージに payload を載せず、consumer は D1 の行を読む（退避キューは受付番号だけ）。Slack の保持を無料のプランの保持の設定（90日）にし、`retention.ts` に置く。投稿を消せる役割。送信と重なった退会の扱い（条件付きの書き換え、`contact_delivered_after_withdrawal`）。`redirect: "manual"` と `new URL()` での宛先の確かめ、許す宛先の差し替えは E2E のエントリだけ、`e2e_contact_posts.user_id`、`section` を文字の境目で分ける。「問い合わせ番号」を「受付番号」に。プライバシー ポリシーと `retention.ts` をこの実装PRで直し、T-19 の改定の手順（7日前の予告）に従う。contact から `users` を直接読まず identity の関数を使う。429 と401 の判定を退会の直接の確かめと同じ `?now` に。E2E を WebKit でも回す。要求定義書・スキル・設定ファイル・手順書の直すところを足した。テスト計画を足した。決めたことを利用者の回答の3つ（と Slack の無料のプラン）に絞り、ほかを決定事項に移した。画面の番号を26に | 仕様書PRのレビュー（セキュリティ・仕様）、利用者の回答（Slack は一旦無料のプラン） |
| 2026-11-23 | 内容の上限を1000文字、回数の上限を1人直近24時間に3件にした（生の文字列は8000文字、本文は8KiB、Slack の `section` は最大2つ）。入口の場所・種類の4つ・自動の返信なし・専用のチャンネルを決めたことに移した。公開の日（`contactStart.json`）を足し、改定日より前は入口を出さず API は404、デプロイの検査で改定日と同じことを確かめる。確認事項から、上限・自動の返信・公開の時期を外した | 利用者の回答（pryusei/kokohima-app#148） |
| 2026-11-23 | 実装した。入口の並びに T-25 の「アプリとして使う」を入れた。webhook の URL は利用者名・パスワード付きも拒む。本文の上限の `Content-Length` が数でなければ400。E2E の確かめる経路の応答の形、文字数の読み上げの作り、デプロイの検査の関数名（`contactStartProblems`）を書いた | T-24 実装PR |
| 2026-11-23 | 実装PRのレビュー：「8.」の Slack の期間を「Slack に届いてから」数える文にした。文字数の `aria-hidden`、要件の F-22 の書き方を直し、テスト計画の済んだ項目にチェックを付けた（WebKit の `@iphone` はこの作業環境に WebKit がないので Chromium の `mobile` だけで確かめた。CI で回る） | T-24 実装PRのレビュー |
