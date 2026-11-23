# T-23 仕様書：問い合わせのフォーム

- 状態：下書き
- タスク票：docs/tasks/T-23-contact.md
- 関係する要件：要求定義書「機能要件」（新しい行 F-22 問い合わせを実装PRで足す）、「AI時代の攻撃を前提にした運用」（保存するデータを減らす）。T-19（プライバシー ポリシー「3.」8・「12.」）、T-13（監視）、T-10（冪等キー・回数の上限）、T-16（退会）、T-17（保持期間）、T-11・T-20（画面）

## 概要
- 今、運営への連絡は `ops@kokohima.app` へのメールだけで、アプリの中から不具合やご意見を送る方法がない。ログインしている利用者が、設定から種類と内容を選んで送れるフォームを作る。
- 送った内容は、運営者だけが入る Slack の非公開のチャンネル（`#kokohima-contact`）に、Incoming Webhook で届ける。API は outbox に1行書くだけにし、Slack への送信は Queues の consumer が行う（CLAUDE.md「外部連携は outbox 経由」）。D1 には、届けるのに要る間だけ内容を持ち、届けたら消す。
- ログインできない人は、今までどおり `ops@kokohima.app` にメールで連絡する（プライバシー ポリシー・利用規約に書いてある）。

## 決めたこと（利用者の回答）
1. 送れるのはログインしている人だけ。入口は設定のトップの節「このアプリについて」に置く。ログインできない人は `ops@kokohima.app`（T-19 の本文のまま）。
2. 届け先は Slack。監視の2つのチャンネル（`#kokohima-alerts`・`#kokohima-notices`。T-13）とは別の、問い合わせ専用の非公開のチャンネル。Incoming Webhook で送る。D1 には、届けるのに要る分を超えて保存しない。
3. 種類は4つから選ぶ：不具合／ご意見／個人情報の開示・削除の請求／その他。内容は自由な文章。
4. 受け付けたことは画面にだけ出す。利用者への自動の返信メールは送らない（「確認事項」）。

## 前提

### コンテキストの分担
- 新しいコンテキスト `contact` を作る：`apps/api/src/contact/{domain,application,infra}` と `routes.ts`。CLAUDE.md の「アーキテクチャ」のコンテキストの一覧に `contact` を足す（実装PR）。
  - `domain/`：種類の一覧、Slack に送る文の組み立てと特殊文字のエスケープ（純粋な TypeScript。fetch・D1 を import しない）。
  - `application/`：受け付け（outbox への書き込みと回数の上限）、届ける処理（consumer から呼ぶ）。
  - `infra/`：D1 の文、Slack の Incoming Webhook への送信（`deps.fetch` を使う）。
- 返信先のメールアドレスは identity の `getNotificationAddress`（今の通知のメールと同じ関数）で読む。contact から identity の表を直接読まない。
- 画面は `apps/web/src/contact/`（フォームと送信のフック）と、ページは `apps/web/src/pages/ContactPage.tsx`。
- 用語：画面の「問い合わせ」はコードで `ContactMessage`。`invitation-domain` スキルの用語表に1行足す（実装PR。お知らせ・リンクのプレビューと同じく、ほかのコンテキストの言葉もこの表に置いている）。

### 番号
- T-21（WebKit の E2E）・T-22（行きたいリスト）・要件の F-18〜F-21 はほかのタスクで使われているので、このタスクは T-23、要件は F-22 にする。

## API
`api-conventions` に従う。例外は下に理由を書く。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/v1/contact-messages` | 必要（`requireAuth`・`requireActiveSession`・`requireSameOrigin`）。`Idempotency-Key` を受け付ける | body：`contactMessageRequestSchema` | 204（本文なし） | 400 `validation_failed`、401 `unauthenticated`（未認証・退会した・同じオリジンでない）、409 `request_in_progress`、422 `idempotency_key_mismatch`、429 `rate_limited`（`Retry-After`） |

- パス：依頼の `/api/v1/contact` ではなく、`api-conventions` の「リソースは複数形」に合わせて `/contact-messages` にする。
- 成功は 204。作ったものを読む経路がない（読める問い合わせのリソースを外に出さない）ので、201 と `Location` は返さない（T-18 の `client-errors` と同じ）。
- ミドルウェアの順番（固定）：`requireAuth` → `requireActiveSession` → `requireSameOrigin` → `idempotency`（T-10） → 本文の上限 → 検証 → 受け付け。
  - `requireSameOrigin`：アクセストークンはメモリにあるので CSRF は起きないが、退会（`POST /me/withdrawal`）と同じく、外の事業者に個人情報を送る操作なので重ねて付ける。
  - `Idempotency-Key`：二重に実行すると Slack に2通届く（結果が変わる）ので受け付ける。T-10 の「`Idempotency-Key` を受け付ける経路」の表に足す。`idempotency_keys` に残るのは本文のハッシュと 204（本文なし）だけで、問い合わせの内容は残らない。
- 本文の上限：16KiB（16384バイト。UTF-8 のバイト数）。`Content-Length` と読み込んだ長さの両方で確かめ、超えたら最後まで読まずに400 `validation_failed`（新しい code は足さない。T-18 と同じ）。内容の上限（2000文字）を4バイトの文字で書き、JSON の改行のエスケープを含めても収まる値。
- 送り主は、いつもアクセストークンの閲覧者（`c.var.viewer.userId`）。本文に `userId`・`email` などの項目を入れても `.strict()` で400 になり、送り主を偽れない。
- 409 `request_in_progress`・422 `idempotency_key_mismatch` は T-10 の共通の動き。

`contactMessageRequestSchema`（`packages/shared/src/schemas/contact.ts`。`.strict()`）：

| 項目 | 型 | 値 |
| --- | --- | --- |
| `category` | enum | `bug`（不具合）・`feedback`（ご意見）・`privacy_request`（個人情報の開示・削除の請求）・`other`（その他） |
| `body` | string | 下の `contactBodySchema` |

`contactBodySchema`：
- 受け取る生の文字列は 16000 文字（UTF-16）まで（正規化の前の歯止め）。
- `\r\n` と `\r` を `\n` に、タブを空白1つにそろえ、NFC に正規化し、前後の空白を除く。
- 1〜2000 文字（コードポイントで数える。`CONTACT_BODY_MAX = 2000`。ひとことの `messageSchema` と同じ数え方）。空なら `too_short`、超えたら `too_long`。
- 改行は許し、数の上限は付けない（不具合の手順を書けるように）。
- 次の文字があれば `invalid_characters`：改行を除く制御文字（`\p{Cc}`）、孤立サロゲート（`\p{Cs}`）、書字方向を変える文字（U+202A〜U+202E・U+2066〜U+2069）。ほかの書式文字（絵文字をつなぐ U+200D など）は許す。表示名・ひとことと違い、運営者だけが読む文章で、見た目の偽装の害が小さいため。
- `category` と `CONTACT_BODY_MAX`・表示の名前（`CONTACT_CATEGORY_LABELS`）も `packages/shared` に置き、API・consumer・画面で同じ値を使う。

## データ
- 新しい表は作らない（マイグレーションなし）。outbox に新しい型 `ContactMessageSubmitted` の行を書く。

`ContactMessageSubmitted` の payload：

| 項目 | 内容 |
| --- | --- |
| `userId` | 送り主（閲覧者）の ID |
| `category` | 種類 |
| `body` | 検証と正規化のあとの内容 |
| `occurredAt` | 受け付けた時刻（ISO 8601、UTC） |

- メールアドレスは payload に入れず、consumer が送る時に identity から読む（決定事項1）。理由：
  - outbox の行は処理から7日（T-12）、退避キューのメッセージは4日（T-13）、D1 の復元用の記録は最大30日残る。payload にメールアドレスを入れると、その間ずっと同じものが別の場所に残る。
  - 送るまでの間に退会したら、`users.email` は NULL になる（T-16）。送る時に読めば、退会した人のアドレスを Slack に出さない。ログインで Google 側の新しいアドレスに変わっていたら、新しいほうに返信できる（T-01）。
  - `SessionStarted` などほかの型も、payload にメールアドレスを入れていない（T-01 のテスト）。同じ決まりにそろえる。
- 届けたら、その行の payload から `category` と `body` を消し、`{ "userId": ..., "occurredAt": ..., "delivered": true }` にする（決定事項2。「振る舞い 3.」）。`userId` と `occurredAt` は、回数の上限を数えるのと、退会のときに消すために残す。行そのものは今の掃除（処理から7日。T-12）で消える。
- 回数の上限は、この型の outbox の行を数える（「振る舞い 1.」）。インデックスは今の `outbox_type_unprocessed (type, processed_at, created_at)` を使う。`created_at` の範囲には効かないが、数える行はこの型の7日分だけ（友達だけの運用で多くて数十行）なので、新しいインデックスは足さない。

## 振る舞い

### 1. 受け付け（`POST /contact-messages`）
- 検証に通ったら、1つの文で outbox に行を書く。回数の上限と退会の確認を同じ文に入れ、同時に送っても上限を超えない（T-04 の送信上限・T-10 の `ics-links` と同じ書き方）：
  ```sql
  INSERT INTO outbox (id, type, payload, created_at)
  SELECT ?id, 'ContactMessageSubmitted', ?payload, ?now
  WHERE EXISTS (SELECT 1 FROM users WHERE id = ?userId AND withdrawn_at IS NULL)
    AND (SELECT COUNT(*) FROM outbox
         WHERE type = 'ContactMessageSubmitted'
           AND json_extract(payload, '$.userId') = ?userId
           AND created_at > ?now - 86400000) < 5
  ```
- 回数の上限：1人あたり、直近24時間（受け付けた時刻で数える、ずれていく窓）に5件まで（`CONTACT_DAILY_LIMIT = 5`。決定事項3）。
  - 行が入らなかった（`changes = 0`）ら、同じ条件で数え直す。5件以上なら429 `rate_limited`。`Retry-After` は、数えた行のうち最も古い行が24時間を過ぎるまでの秒数（切り上げ。1以上）。5件未満なら、そのあいだに退会したとみなして401 `unauthenticated`（`requireActiveSession` と同じ答え）。
  - 退会したとき、本人の `ContactMessageSubmitted` の行は消える（「5.」）ので、数からも外れる。
  - Workers の Rate Limiting（おおよその数）は使わない。5件という小さな上限は、厳密に数える必要があるため（T-10「部品の役割」）。
- 成功したら204。画面に出すのは「受け付けた」ことだけ。
- ログ：受け付けのログは出さない。上限を超えたときは、T-10 の共通の `rate_limited` と同じ形（`{ event: "rate_limited", group: "contact_messages" }`。利用者 ID は出さない）を出す。内容・種類・メールアドレス・利用者 ID はどのログにも出さない。

### 2. outbox から Queues へ
- `ContactMessageSubmitted` を、dispatch の「常に流す型」（`apps/api/src/jobs/dispatch.ts` の `CALENDAR_TYPES`）に足す。`NOTIFICATION_START_AT` に左右されない。
- consumer（`apps/api/src/jobs/consumer.ts` の `handleCalendarSide` の振り分け）で `ContactMessageSubmitted` を contact の `deliverContactMessage` に渡す。`createFromEvent`（通知）は今までどおり呼ばれるが、この型の下書きを作らない（`draftsFor` に型がない。実装PRで「お知らせが作られない」ことをテストする）。
- E2E の `/__e2e__/outbox/drain` は `dispatchedTypes` を読むので、何もしなくてもこの型を流す。

### 3. 届ける処理（consumer）
`deliverContactMessage(ctx, outboxId, payload)`。何度呼んでも、Slack に届くのは原則1通（下の「受け入れること」）。

1. outbox の行を読む。行がない（退会で消えた）、または payload に `delivered: true` がある（届け済み）なら、何もせずに終える（ack）。
2. 送り主を読む：`users` の `withdrawn_at` と、`getNotificationAddress` でメールアドレス。退会していたら、送らずに payload を「届けた」と同じ形に消して終える（退会した人の内容とアドレスを外に出さない。決定事項4）。
3. Slack に送る文を、domain の関数で組み立てる（「4.」）。
4. `CONTACT_SLACK_WEBHOOK_URL` に `POST` する（`deps.fetch`、`Content-Type: application/json`、5秒で打ち切る。T-10 の外部の呼び出しと同じ）。
   - URL が設定されていない、または `https://hooks.slack.com/services/` で始まらない（E2E は「8.」の偽の宛先）：`ContactWebhookNotConfigured` を投げる（送らない。設定の誤りで別の宛先に個人情報を送らないため）。
   - 応答が 200 以外：`ContactWebhookRejected` を投げる。Slack の 429 も同じ（Queue の再試行の間隔は30秒から倍々。T-06）。
   - 例外の `message` に、URL・応答の本文・問い合わせの内容を入れない（consumer の `job_failed`・`job_dead_lettered` のログは例外の `name` だけを出すが、念のため）。
5. 200 なら、行の payload を `{ userId, occurredAt, delivered: true }` に書き換える（`UPDATE outbox SET payload = ? WHERE id = ? AND type = 'ContactMessageSubmitted'`）。
- 失敗したら投げて、Queue の再試行に任せる（`max_retries: 5`）。最後の失敗は退避キューに入り、今の `job_dead_lettered`（`type: "ContactMessageSubmitted"`）の「すぐ見る」アラートで気づく（T-13）。新しいアラートは足さない。
- やり直し：outbox の行の `processed_at` を NULL に戻す（T-13「8.」のまま）。届かなかった行は payload が残っているので、そのままやり直せる。
- 受け入れること：Slack が受け取ったあと、5 の書き換えの前に止まると、再試行でもう1通届く。届いた文には問い合わせ番号（outbox の `id`）が入るので、運営者は重なりに気づける。

### 4. Slack に送る文（決定事項5）
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
      { "type": "plain_text", "text": "問い合わせ番号：<outbox の id>", "emoji": false }
    ] },
    { "type": "section", "text": { "type": "plain_text", "text": "<内容>", "emoji": false } }
  ]
}
```

- 載せるもの：種類（表示の名前）、返信先のメールアドレス、受け付けた時刻（`Asia/Tokyo` で表す。payload の `occurredAt` から）、利用者 ID、問い合わせ番号、内容。表示名は載せない（返信と本人の確認には ID とメールアドレスで足りる）。
- 返信先がない（`users.email` が NULL）ときは「返信先：登録なし」。
- `text`（通知とスマホの通知の要約に出る）は「問い合わせ：<種類>」だけにし、内容とメールアドレスを入れない（Slack のスマホの通知に個人情報を出さない）。
- 利用者の文が Slack の書式として読まれないようにする：
  - 利用者が書いたもの（内容）と、外から来たもの（メールアドレス）は、`plain_text` の欄にだけ入れる。`mrkdwn` を使わないので、`*太字*`・`<https://...|文字>`・`<!channel>`・`<@U...>`・`<!here>` は書式・リンク・メンションにならない。`"emoji": false` で `:名前:` も絵文字にしない。
  - そのうえで、送るすべての文字列の `&`・`<`・`>` を `&amp;`・`&lt;`・`&gt;` にする（Slack の公式が、書式の制御に使う3つの文字として、エスケープを求めている）。`@channel`・`@here` を文字のまま書いても、Incoming Webhook は `link_names` を付けないかぎりメンションにしない（「人が確かめること」で確かめる）。
  - `plain_text` の欄でエスケープした `&amp;` が `&` と出るか、`&amp;` のまま出るかは公式で確かめられていない。人が確かめ、文字のまま出るなら、`plain_text` の欄ではエスケープをやめる（`mrkdwn` を使わないことで足りる）よう、実装PRで仕様書を直す。
  - `unfurl_links`・`unfurl_media` を `false` にし、内容に書かれた URL を Slack が読みに行かない（リンク先に、運営が見たことを知らせない）。
- Slack の上限：`section` の `text` は3000文字、`fields` の各欄は2000文字、`header` は150文字。内容は2000文字までなので、エスケープで伸びても（最大で1文字が5文字）3000文字を超えうる。組み立てで、エスケープのあとの長さが3000文字を超えるときは、内容を2つ目の `section` に分ける（1つの `section` は3000文字まで。最大で4つ）。

### 5. 退会
- T-16 の「入口を止める段」の、outbox の本人だけに関わる行を消す型の一覧に `ContactMessageSubmitted` を足す（処理済み・未処理とも）。まだ届けていない問い合わせも消え、届かない。
- consumer に渡ったあとに退会したときは、「3.」の2で送らない。
- 退会の前に Slack に届いたものは、運営者が Slack で消す（「7.」の運用）。プライバシー ポリシーの「退会したとき」に書く。

### 6. 保持期間
| データ | 消す時点 |
| --- | --- |
| outbox の payload の種類・内容 | Slack に届けたとき（届かなかった行は、処理から7日で行ごと消える） |
| outbox の行（`userId`・`occurredAt` だけ） | 処理から7日（T-12。今の掃除のまま） |
| 退避キューのメッセージ（種類・内容・利用者 ID。メールアドレスは入らない） | Queues の保持期間（既定4日。T-13） |
| D1 の復元用の記録 | 最大30日（今のまま。#89） |
| Slack のメッセージ | 運営者が、対応を終えたら手で消す。遅くとも受け付けから90日以内（決定事項6。「確認事項」） |
| `idempotency_keys`（本文のハッシュと204だけ） | 24時間（T-10） |

- T-17「1. 保持期間の一覧」に、上の行を足す（実装PR）。

### 7. 運営者の扱い（手順書）
- `#kokohima-contact` は非公開のチャンネルにし、メンバーは運営者だけにする。Slack のワークスペースは2段階認証を必須にする。ゲスト・外のワークスペースとの共有（Slack コネクト）・ほかのアプリの連携を、このチャンネルに入れない。
- 監視の決まり「ログの本文は Slack に流さない」（T-13「4.」、手順書の冒頭）の例外は、このチャンネルだけ。監視の2つのチャンネルには今までどおり流さない。問い合わせの内容を、監視のチャンネル・issue・PR・ほかのチャンネルに貼らない。
- 返信は `ops@kokohima.app` から、Slack に出た返信先に送る。個人情報の開示・削除の請求は、送り主がログインして送ったこと（利用者 ID）で本人と確かめ、登録のメールアドレスにだけ答える（T-19「12.」）。
- 対応を終えたら、Slack のメッセージを消す。月に1回、90日を過ぎたメッセージが残っていないかを確かめる。
- webhook の URL は秘密情報。`wrangler secret` にだけ登録し、Cloudflare の通知先（T-13 の webhook）・Better Stack には登録しない。漏れたら Slack 側で作り直し、`wrangler secret put` し直す。

### 8. 設定値・テストの差し替え
- 秘密情報：`CONTACT_SLACK_WEBHOOK_URL`（`Bindings` に足す）。`wrangler secret put CONTACT_SLACK_WEBHOOK_URL --env prod`（staging は別のチャンネルの webhook を入れるか、入れない）。`.dev.vars` はコミットしない。`apps/api/dev-vars.example` に名前だけを足す。
- ローカル（`pnpm dev`）：値を入れなければ、consumer は `ContactWebhookNotConfigured` で失敗し、ローカルのキューの中で再試行・退避するだけ（本物の Slack には届かない）。届くことを確かめるときは、E2E の偽物を使う。
- staging で入れないときも同じく退避キューに入る（staging には Monitors がない）。
- E2E：`apps/api/scripts/write-e2e-dev-vars.mjs` が `CONTACT_SLACK_WEBHOOK_URL=https://slack.e2e.invalid/services/e2e` を書く。E2E のエントリ（`apps/api/src/e2e/entry.ts`）で、contact の deps の「許す接頭辞」を偽の宛先に差し替え、`e2eFetch` が `slack.e2e.invalid` への送信を E2E だけの表（`e2e_contact_posts`。本番のマイグレーションに入れない。T-07 の偽のメールと同じ作り）に残す。
  - 確かめる経路：`GET /__e2e__/contact/posts`（`requireAuth`）。閲覧者の利用者 ID を含む送信だけを返す（並んで走るテストの送信は返さない）。
- 単体テスト：`AppDeps` の `fetch` を差し替え、送った JSON を確かめる。

### 9. 画面（決定事項7）
キャンバスに問い合わせの画面はない。デザインシステムのトークン（`apps/web/src/index.css`）と `apps/web/src/ui/` の部品だけで作る。

#### 入口
- 設定のトップ（`SettingsPage`）の節「このアプリについて」の最初の行に「問い合わせ」（`/settings/contact`）を足す。並びは「問い合わせ」「プライバシー ポリシー」「利用規約」。今の `Row` を使う。

#### 画面の枠
- `/settings/contact` は、ほかの設定の画面と同じ `SubScreen`（題「問い合わせ」、`back="/settings"`）。シートにしない：設定の下の画面はどれも `SubScreen` で、シートは誘い・募集などタブの上に重ねる詳細と作成だけ（T-11「画面のつながり」）。
- PC の配置（幅1024px以上）では、`SubScreen` のとおり左のナビを出し、ナビの「設定」に `aria-current="page"` が付く（T-20。`/settings` の下の画面はすべて同じ）。中身は1列のまま、T-20 の中身の幅（`max-w-3xl`）の中に置く。幅で描き分けない。
- `App.tsx` の振り分けに `/settings/contact` を足す。ログインしていなければ、ほかの設定の画面と同じくログインへ。

#### 中身（上から）
1. 説明（`p`）：「不具合・ご意見・個人情報の求めなどを、運営に送れます。返事が要るものは、ログインに使っているアカウントのメールアドレスにお送りします。」
2. 入力のカード（`rounded-l bg-surface p-4 shadow-card`、中は `flex flex-col gap-4`）：
   - 種類：`ChipRow`（ラベル「種類」）に4つの `Chip`（「不具合」「ご意見」「個人情報の開示・削除の請求」「その他」）。初めはどれも選ばない。1つだけ選べる（選んだものは `aria-pressed="true"`）。
   - 「個人情報の開示・削除の請求」を選んだときだけ、すぐ下に `Note`：「本人の確認のため、返事はログインに使っているアカウントのメールアドレスにだけお送りします。アカウントとデータをすべて消すときは、設定の『アカウント』から退会もできます。」
   - 内容：`Field`（ラベル「内容」）の中に `textarea`（新しい `textareaClass`。下の「新しい部品」）。高さは8行ぶん、縦にだけ伸ばせる。`maxLength` は付けない（コードポイントで数えるため。超えたら送れなくするだけ）。
   - 文字数：入力欄の下の右に `CharCount`（「123 / 2000」）。数え方は `contactBodySchema` と同じ（正規化して前後の空白を除いたコードポイント）。2000を超えたら「2000文字までです（123文字多い）」の文にする。色は `text-ink-muted` のまま（赤にしない）。`aria-live="polite"` で、超えたときだけ読み上げる。
   - 送り先の説明（`Note`）：「送った内容は、運営の連絡用の Slack（米国の Slack 社のサービス）に届きます。パスワードや、ほかの人の個人情報は書かないでください。くわしくは」＋「プライバシー ポリシー」（`Link` で `/privacy`）。
   - 送るボタン：`SendButton`（「送る」、`block`）。種類が選ばれていない・内容が空・2000文字を超える・送信中・オフラインのときは押せない。
3. オフラインの間は、`SubScreen` のオフラインの帯に加えて、ボタンの下に `Note`「オフラインの間は送れません」（T-11「オフライン」）。

#### 送ったあと（静かな成功）
- 入力のカードを、同じ大きさのカードの確認に置き換える（`role="status"`）：見出し「送りました」と、「受け付けました。返事が要るものは、メールでお返しします。」。下に `ButtonLink`（`variant="ghost"`、「設定に戻る」→ `/settings`）。`Toast` は使わない（消えると、送れたか分からなくなるため）。
- 成功の色（成立の `meet`）も使わない。ふつうの面と文字のトークンだけ。
- 同じ画面で続けて送るボタンは出さない（もう一度送るときは、設定から開き直す）。

#### 送れなかったとき（静かな失敗）
- 入力した内容と種類は残す。ボタンの上に `p`（`role="status"`、`text-ink-muted`）で出す。赤・エラー色・警告の印を使わない（CLAUDE.md）。
  | 応答 | 文言 |
  | --- | --- |
  | 通信できない・5xx・409 `request_in_progress`・422 `idempotency_key_mismatch` | 「送れませんでした。もう一度お試しください。」 |
  | 429 `rate_limited` | 「今日はこれ以上送れません。時間をおいて、もう一度お試しください。」 |
  | 400 `validation_failed` | 「送れませんでした。内容を確かめてください。」（画面の検証を通っているので、ふつうは出ない） |
  | 401 | 今のAPIクライアントのまま（1回だけ取り直し、だめならログアウトの状態。T-01） |
- 冪等キー：`useIdempotencyKey`（T-10）。通信できない・5xx のあと、内容を変えずにもう一度押したら同じキー。4xx・内容や種類の変更・成功のあとは新しいキー。
- 送信は TanStack Query の `useMutation` と `apiSend`（`data-fetching` スキル）。応答に本文がないので、無効にするクエリはない。楽観的更新はしない（送れたかを、サーバーの応答で決めてから出す）。
- 書きかけの内容を `localStorage`・`sessionStorage` に残さない（個人情報を含みうるため。画面を離れたら消える）。

#### 新しい部品（`apps/web/src/ui/form.tsx`）
- `textareaClass`：`inputClass` に複数行の分（`py-2`・`min-h-40`・`resize-y`・`leading-normal`）を足したもの。今のひとことの `textarea`（`InviteNewPage`・`BroadcastNewPage`）は、この実装PRでは変えない（仕様書にない振る舞いを変えないため。そろえるのは別のタスク）。
- `CharCount({ count, max })`：「count / max」と、超えたときの文。`text-xs text-ink-muted tabular-nums`、右寄せ。ほかの長い入力（ひとことなど）でも使える形にする。
- T-11「共通の部品」に、この2つを足す（実装PR）。

### 10. 文書の直し（決定事項8）
「実装PRで直すもの」にまとめる。プライバシー ポリシーの改定は、T-19 の改定（外国にある第三者への提供。ブランチ `spec/T-19-art28` の仕様書PR）の書き方に合わせる。

## 認可と秘匿
- 閲覧者IDの使い方：送り主は、いつもアクセストークンの閲覧者。本文で送り主を指定できない（`.strict()`）。outbox の行の `userId` も閲覧者で、consumer はその ID のメールアドレスだけを読む。
- 他人のデータに届かないことの保証：読み取りの経路がない。応答は204で、ほかの人の情報も、自分の問い合わせの中身も返さない。Slack に出るメールアドレスは、送り主本人のもの（consumer が outbox の `userId` で読む）。利用者 A が B の ID を本文に入れても、送り主は A のまま。
- 区別させない応答：ほかの利用者に関わる応答の差はない。429 は本人の送った数だけで決まる。
- 秘匿：
  - ログ：内容・種類・メールアドレス・利用者 ID・webhook の URL を出さない。consumer の失敗のログは今の `job_failed`・`job_dead_lettered`（`kind`・`type`・`id`・`attempts`・`error` の名前）だけ。
  - payload にメールアドレスを入れない。届けたら内容を消す。
  - Slack の文：利用者の文は `plain_text` に入れ、`&`・`<`・`>` をエスケープし、メンション・リンク・書式・リンクの展開を起こさせない。スマホの通知の要約に内容を出さない。
  - webhook の URL は `wrangler secret` だけ。送る前に接頭辞を確かめ、設定の誤りでほかの宛先に送らない。
  - 退会した人の問い合わせは、まだ届けていなければ届けない。
- 悪用：Slack への大量の投稿は、1人24時間に5件と本文の上限で抑える。利用者は友達の招待でしか増えない（T-02）。全体の上限は付けない（「確認事項」）。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 正常系：ログインした A が送ると204で、outbox に `ContactMessageSubmitted` の行が1つだけでき、payload が `userId`（A）・`category`・`body`（正規化のあと）・`occurredAt` だけで、メールアドレスを含まない
- [ ] 入力検証（`packages/shared` のスキーマ）：知らない項目（`userId`・`email` を含む）、一覧にない `category`、`body` がない・数値は400。`body` の正規化（`\r\n`・`\r` → `\n`、タブ → 空白、NFC、前後の空白）。制御文字・孤立サロゲート・書字方向を変える文字は `invalid_characters`、改行・絵文字をつなぐ文字（U+200D）は通る
- [ ] 境界値：`body` が空・空白だけは `too_short`、2000文字（4バイトの文字・サロゲートペアで作る）は通り、2001文字は `too_long`。本文がちょうど16384バイトは検証まで進み、16385バイトは400（`Content-Length` がない・偽りでも、読み込んだ長さで400）
- [ ] 認証：アクセストークンがない・不正なら401で、outbox に行ができない。`Origin` が違う・ないと401
- [ ] 退会：退会した利用者のアクセストークン（期限内）は401で、行ができない。受け付けの文の中で退会と重なったら（`withdrawn_at` を入れてから文を実行）401
- [ ] 送り主を偽れない（「他人のIDでは取得・更新できない」）：A のトークンで、本文に B の `userId` を入れると400。正しい本文で送ると、行の `userId` は A で、consumer は A のメールアドレスを Slack に出し、B のアドレスは出ない
- [ ] 回数の上限：24時間に5件まで。6件目は429・`Retry-After` が最も古い行が24時間を過ぎるまでの秒数。ちょうど24時間前の行は数えない（24時間を過ぎたら6件目が通る）。B の送った数は A の上限に影響しない。同時に6件送っても5件しか入らない。上限を超えたときのログは `rate_limited` と `group` だけ
- [ ] 冪等：同じ `Idempotency-Key`・同じ本文の再送は204で、outbox の行は1つ（Slack にも1通）。違う本文なら422。`idempotency_keys` に問い合わせの内容が入らない
- [ ] 書き込みが1つの文：上限の判定と行の書き込みが分かれていない（同時の送信のテストで確かめる）
- [ ] consumer：偽の Slack に1回だけ `POST` し、`text` が「問い合わせ：<種類>」だけ、`blocks` に種類・返信先（A の登録のメールアドレス）・日本時間の受付・利用者 ID・問い合わせ番号・内容が入り、`unfurl_links`・`unfurl_media` が `false`、利用者の文の欄がすべて `plain_text`・`emoji: false`
- [ ] consumer のエスケープ：内容に `<!channel>`・`<!here>`・`<@U123>`・`<https://example.com|押して>`・`&`・`@channel` を入れると、送る JSON では `&lt;!channel&gt;`・`&amp;` などになり、`<`・`>` がそのまま残らない。メールアドレスの欄も同じ。エスケープで3000文字を超える内容は `section` に分かれ、どの `section` も3000文字以下
- [ ] consumer：返信先がない（`email` が NULL）と「返信先：登録なし」
- [ ] consumer：届けたら payload が `userId`・`occurredAt`・`delivered` だけになる。同じメッセージをもう一度処理しても送らない。行がない・届け済みなら送らずに終える
- [ ] consumer：送る前に退会していたら、送らずに payload の内容を消す
- [ ] consumer の失敗：200 以外・Slack の 429・通信の失敗・5秒の打ち切りで投げ、payload は残る。URL が未設定・`https://hooks.slack.com/services/` で始まらないと送らずに投げる。最後の試行で `job_dead_lettered`（`type: "ContactMessageSubmitted"`）が warn で出る
- [ ] ログに出ない：受け付け・上限・consumer の成功と失敗のどの場合も、`console` の全出力に内容・メールアドレス・利用者 ID・webhook の URL が含まれない（内容とアドレスに見分けやすい文字列を入れて確かめる）。例外の `message` にも入らない
- [ ] お知らせを作らない：この型の行を流しても `notifications` に行ができない
- [ ] 退会：入口を止める段で、本人の `ContactMessageSubmitted` の行（処理済み・未処理とも）が消え、相手（ほかの利用者）の行は残る
- [ ] dispatch：`NOTIFICATION_START_AT` が未設定でも、この型を流す
- [ ] Web：設定のトップの「このアプリについて」の最初の行に「問い合わせ」があり、`/settings/contact` に移る。`/settings/contact` は `SubScreen`（題「問い合わせ」、戻るで `/settings`）
- [ ] Web：種類を選ばない・内容が空・2000文字を超えるときは「送る」を押せない。文字数の表示が正規化のあとのコードポイントで数え、超えたら超えた数の文になる。色の指定に赤・エラー色（Tailwind の既定の色を含む）がない
- [ ] Web：「個人情報の開示・削除の請求」を選んだときだけ、本人の確認と退会の `Note` が出る
- [ ] Web：送ると `POST /api/v1/contact-messages` に `category`・`body` と `Idempotency-Key` が付き、204で「送りました」の確認（`role="status"`）に置き換わる。入力欄は消える
- [ ] Web：429・5xx・通信できない・400 で、それぞれの文言が静かに出て、入力が残る。通信できない・5xx のあとに同じ内容で押すと同じキー、内容を変えると新しいキー
- [ ] Web：オフラインでは押せず、「オフラインの間は送れません」が出る
- [ ] Web：書きかけの内容を `localStorage`・`sessionStorage` に書かない
- [ ] Web の部品：`CharCount` が「count / max」と、超えたときの文を出す。`textareaClass` が `inputClass` の幅の指定（`min-w-0`・`max-w-full`）を含む

### E2Eテスト（対象にする利用者の流れ）
- [ ] ログインした人が、友達タブ → 設定 → 「問い合わせ」で、種類「不具合」を選び、内容（`<!channel> & テスト` を含む）を書いて送ると、「送りました」が出る。`/__e2e__/outbox/drain` のあと、`GET /__e2e__/contact/posts` で、その人の送信が1通だけあり、内容がエスケープされている（`<!channel>` がそのまま入っていない）。`e2e/contact.spec.ts`。今の `mobile` の設定でも回る（T-20）
- 回数の上限・失敗の文言・退会は単体テストで確かめる（E2E のサーバーでは上限の数え方を変えないが、6回送る流れは E2E にしない）。

### 人が確かめること（本番で設定するとき。手順書に書く）
- `#kokohima-contact` に、staging か本番で自分のアカウントから1通送り、届いた文を見る：
  - `&`・`<`・`>` が文字どおりに出る（`&amp;` などのまま出たら、「4.」のとおり仕様を直す）。
  - `<!channel>`・`@channel`・`@here`・`<@自分のID>`・`<https://example.com|押して>`・`*太字*`・`:smile:` が、メンション・リンク・書式・絵文字にならない。
  - URL を書いても、リンクの展開（プレビュー）が出ない。
  - Slack のスマホの通知に、内容とメールアドレスが出ない。
- チャンネルが非公開で、メンバーが運営者だけであること。

## 実装PRで直すもの
- 要求定義書：「機能要件」に F-22 問い合わせ（ログインした人が設定から送る。Slack の非公開のチャンネルに届く。1日5件）。「技術の選定」の外部の連携に Slack（問い合わせ）を一言。
- CLAUDE.md：「アーキテクチャ」のコンテキストの一覧に `contact`。
- `invitation-domain` スキルの用語表：「問い合わせ | ContactMessage」。
- `api-conventions` スキル：変えない（`/contact-messages` は今の決まりのとおり。204 の理由はこの仕様書に書いた）。
- T-10：「`Idempotency-Key` を受け付ける経路」に `POST /contact-messages`。「回数の上限を付ける経路」の表に `POST /contact-messages`（利用者 ID、直近24時間で5件（厳密）、D1（outbox の行の数）、429 `rate_limited`）と、`Retry-After` の決め方。
- T-12 データの増加：outbox の型の一覧があればこの型を足す。T-12 リリース：本番の秘密の一覧に `CONTACT_SLACK_WEBHOOK_URL`（`wrangler secret put --env prod`）。
- T-13：「4. アラートの一覧」の Slack のチャンネルの説明に、`#kokohima-contact` は監視の通知先ではなく、ログの本文を流さない決まりの例外であること。「8. 退避キューの調べ方」に、`ContactMessageSubmitted` のメッセージには問い合わせの内容が入る（メールアドレスは入らない）こと。「10. ログを見られる人の範囲」に、このチャンネルも運営者だけ。
- 手順書（`docs/runbooks/monitoring.md`）：
  - 冒頭の「ログの本文は Slack に流さない」に、例外は `#kokohima-contact` だけ（問い合わせの内容とメールアドレスが入る）と足す。
  - 「1-1. Slack」に3つ目のチャンネル `#kokohima-contact`（非公開・運営者だけ・通知はオン・ゲストと Slack コネクトなし）と、その webhook は `wrangler secret`（`CONTACT_SLACK_WEBHOOK_URL`）にだけ登録し、Cloudflare の通知先・Better Stack には登録しないこと。漏れたときの作り直し。
  - 「2. アラートごとの最初の対応」の `job_dead_lettered` に、`type` が `ContactMessageSubmitted` のとき（webhook の作り直し・チャンネルの削除を疑う。直したら outbox の `processed_at` を NULL に戻す）。
  - 「3-1. メッセージの本文を見る」に、この型の本文には問い合わせの内容が入るので、見ずにやり直すこと。
  - 新しい節「問い合わせの受け方」：「振る舞い 7.」（返信、開示・削除の請求の本人の確認、対応を終えたら消す、月に1回90日を過ぎたものを確かめる、ほかの場所に貼らない）と「人が確かめること」。
  - 今の「4. 問い合わせの調べ方」（友達から聞いた不具合のログの引き方）は、名前が重なるので「4. 不具合の知らせの調べ方」にし、問い合わせのフォームで届いた不具合も、問い合わせ番号と受付の時刻からログを引けることを足す。
- T-16：入口を止める段の outbox を消す型の一覧に `ContactMessageSubmitted`。
- T-17：「1. 保持期間の一覧」に「振る舞い 6.」の行。
- T-18：`clientErrorReportSchema` の `route` の一覧に `/settings/contact`（T-18 が先に main に入っていたら、この実装PRで `packages/shared` も直す。後なら T-18 の実装PRで足す）。
- T-19（プライバシー ポリシー。ブランチ `spec/T-19-art28` の改定の仕様書PRがマージされたあとの文に重ねる。先にこの実装PRが入るなら、T-19 の改定の実装PRで合わせる）：
  - 「2. 預かる情報」の「あなたが入力するもの」に、問い合わせの種類と内容（送るときに、ログインのメールアドレスと利用者を区別する番号を一緒に運営に届けること）。
  - 「3. 使う目的」：8（問い合わせに答える）は今のまま使う。7（障害に気づいて直す）に「問い合わせで知らせてもらった不具合を直すため」を足し、ご意見をサービスの改善に使うことを新しい目的（9.「問い合わせでもらったご意見をもとに、このサービスを良くするため」）として足す（今の本文に改善の目的がないため）。直後の「メールアドレスは、5.・8.・『12.』にだけ使います」に、問い合わせに答えるため、返信先として運営の連絡用の Slack に届けることを足す。
  - 「5. 委託」に「Slack Technologies, LLC（米国）」：任せること＝問い合わせを運営者に届けて保管する。渡すもの＝問い合わせの種類・内容・受け付けた時刻・利用者を区別する番号・返信先のメールアドレス。「監視のためのサービス」の「どちらにも、利用者の情報は渡しません」は、監視の通知についての文のまま残し、問い合わせは別の項目にする。
  - 「7. 外国にある事業者への提供」（T-19 の改定のあとの節）：外国の事業者の並びと「体制を整えていることの確かめ方」に Slack（Slack のデータ処理に関する契約（DPA）。事業者の契約・条件は T-19 の確認事項（b）4 と同じく、デプロイの前に人が確かめる）。改定の文の「障害の知らせ（Slack）…個人情報は渡しません」は、監視の通知に限った文に直す。
  - 「8. 保存する期間」に「問い合わせ：運営に届けたら、このサービスのデータベースから内容を消します。うまく届かなかった記録は4日〜7日で消えます。運営の連絡用の Slack に届いたものは、対応を終えたら消し、遅くとも受け付けから90日で消します。」。「退会したとき」に、まだ届けていない問い合わせは届けずに消すこと、届いたものは上の期間で消えること。
  - 「12. 開示・訂正・削除などの求め」に、ログインしているならアプリの「設定 → 問い合わせ」（種類「個人情報の開示・削除の請求」）からも求められ、登録のメールアドレスに答えること。
  - 改定日（T-19「8. 改定のしかた」）。集める情報と委託先が増えるので、T-19「8.」の「大事な変更」にあたる（前もって知らせる仕組みがない。「確認事項」）。
  - 「9. 本文とアプリをそろえ続ける」の、本文を直すタスクの並びに T-23（問い合わせ）を足す。
- T-11：「共通の部品」に `textareaClass`・`CharCount`（`ui/form.tsx`）。「画面のつながり」の設定の表に `/settings/contact`（問い合わせ。新しい画面。設定のトップの「このアプリについて」から開く）。「画面ごとの置き換え」の表に「キャンバスなし（24 問い合わせ）| `ContactPage`」。
- T-20：「E2E」の、PC で横にはみ出さない主な画面の一覧に、問い合わせを足すか（任意。足すなら同じPRでテストも）。
- `docs/design/README.md`：「画面一覧」の「設定」の行に「問い合わせ（種類と内容、送ったあとの確認）」。画面の数（約22画面）を直す。
- `docs/design/claude-design-prompts.md`：「## 設定」に「24. 問い合わせ：種類（4つのチップ）・内容（複数行と文字数）・Slack に届くことの説明、送ったあとの静かな確認、送れなかったときの静かな文言。個人情報の請求を選んだときの説明」。キャンバス（MVP画面）への追加は、人が Claude Design で行う（「確認事項」）。
- `apps/api/dev-vars.example` と `apps/api/scripts/write-e2e-dev-vars.mjs`：`CONTACT_SLACK_WEBHOOK_URL`。
- `.github/pull_request_template.md`：変えない（「集める情報・外に渡すものを変える PR は `/privacy` を直す」の確かめる項目があれば、それに従う）。

## スコープ外
- ログインしていない人のフォーム（`ops@kokohima.app` のメールのまま）。
- 利用者への自動の返信メール、送った問い合わせの一覧・履歴の画面、運営者が画面から返事をする機能。
- ファイル・スクリーンショットの添付。
- 問い合わせを D1 に残す仕組み、集計、Slack 以外の届け先（メール・チケットの管理）。
- 画面のエラーの情報（T-18）や端末の情報を問い合わせに自動で付けること。
- 全体（全員あわせて）の回数の上限。
- 今のひとことの入力欄を `textareaClass`・`CharCount` にそろえること（別のタスク）。

## 決定事項（仕様書PRのレビューで合意する）
1. 返信先のメールアドレスは payload に入れず、consumer が送る時に identity から読む（「データ」の理由）。（提案）
2. 届けたら outbox の payload から種類と内容を消す。届かなかった行は、やり直せるように残す（処理から7日で消える）。（提案）
3. 回数の上限は1人24時間に5件。outbox の行を1つの文で数える（新しい表を作らない）。本文の上限は16KiB、内容は2000文字。（提案）
4. 送る前に退会していたら届けない。退会で未処理の行も消す。（提案）
5. Slack の文は Block Kit の `plain_text` だけで組み、`&`・`<`・`>` をエスケープし、リンクの展開を止め、通知の要約に内容を出さない。（提案）
6. Slack のメッセージは、運営者が対応を終えたら手で消し、遅くとも受け付けから90日以内に消す。プライバシー ポリシーにそう書く。（提案。「確認事項」）
7. 画面は設定の下の `SubScreen`（`/settings/contact`）。種類はチップ、内容は複数行の入力欄と文字数。成功は同じ場所の静かな確認、失敗は静かな文言。新しい部品 `textareaClass`・`CharCount` を `apps/web/src/ui/form.tsx` に置く。（提案）
8. プライバシー ポリシーに、集める情報・委託先（Slack、米国。T-19 の改定と同じ相当措置）・保存期間・開示の求めの方法を足す。（提案）

## 確認事項（合意前に解消する）
- Slack のメッセージの保持：運営者が手で消し、遅くとも90日（提案）でよいか。Slack の無料のプランでは、ワークスペースの保持期間を設定できず（有料のプランの機能）、古いメッセージは Slack の定めで消える。有料のプランならチャンネルの保持期間（例：90日）を設定して、手で消すのと重ねる。どちらにするか、ポリシーに何日と書くか。
- 内容の上限（2000文字。提案）と、回数の上限（1人24時間に5件。提案）でよいか。
- 利用者への自動の返信メール：送らない（画面の確認だけ。提案）でよいか。送るなら、Resend（T-07）で「受け付けました」を送る経路と、メールの上限の扱いを足す。
- プライバシー ポリシーの「大事な変更」（T-19「8.」：集める情報・委託先が増える）にあたる。前もって知らせる仕組みはまだない。問い合わせの画面に Slack に届くことの説明を出したうえで、改定日を入れて公開する（提案）でよいか。前もってメールなどで知らせるなら、その方法を決める。
- Slack の事業者の契約（DPA）と、外国にある第三者への提供の相当措置（T-19 の改定）に Slack を入れてよいか。契約の中身は、T-19 の確認事項（b）4 と同じく、デプロイの前に人が確かめる。
- staging に `#kokohima-contact` と別のチャンネルの webhook を入れるか（入れないと、staging の問い合わせは退避キューに入るだけ）。
- キャンバス（MVP画面。docs/design/README.md）に「24 問い合わせ」を足すか。足すなら、実装の前に人が Claude Design で作る。足さないなら、この仕様書の「9.」とトークン・部品で作る。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書き | 利用者の依頼（ログインした人だけ、設定から、Slack の専用の非公開のチャンネルに届ける、種類は4つ、自動の返信はしない） |
