# T-59 仕様書：メールの送信を Cloudflare Email Service に移す

- 状態：仕様書
- タスク票：docs/tasks/T-59-cloudflare-email.md
- 関係する要件：NF-01、NF-02、NF-07、技術選定の「メール配信」
- 関係する仕様書：T-07（docs/specs/T-07-notification.md「外部とのつなぎ方」「設定値」決定事項1・8）、T-23（docs/specs/T-23-rich-mail.md）、T-12（docs/specs/T-12-release.md「人が行う作業」4）、T-13（docs/runbooks/monitoring.md）、T-16（docs/specs/T-16-withdrawal.md「スコープ外」）、T-19（docs/specs/T-19-privacy-terms.md 本文の5.・7.・8.、決めたこと17）

## 概要
今のメール（T-07 のお知らせのメール、新しい端末でのログインの知らせ、T-23 の HTML のメール）は、すべて Resend の API で送っている。これを、Workers の `send_email` バインディングで送る Cloudflare Email Service に移す。外部の事業者を1つ減らし、秘密情報（`RESEND_API_KEY`）を持たずに済むようにする。

送る部品を差し替えられる形にし、設定値で Resend と Cloudflare を切り替える。持ち主が実機に届くことを確かめてから Cloudflare に切り替え、そのあとの小さな PR で Resend を外す（一気に切り替えるより戻しやすい）。メールの中身・送る条件・上限・差出人は変えない。

## 調べて分かった事実（2026-11-28 に公式で確かめた）

| 項目 | 事実 | 出典 |
| --- | --- | --- |
| 状態 | Email Sending は公開ベータ（2026-04-16 から） | [Changelog](https://developers.cloudflare.com/email-service/platform/changelog/)、[公開ベータの告知](https://blog.cloudflare.com/email-for-agents) |
| 送れる宛先とプラン | Workers 有料プランで、送信ドメインを登録すれば任意の宛先に送れる。無料プランはアカウントで確かめた宛先だけ | [Limits](https://developers.cloudflare.com/email-service/platform/limits/)、[Pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| 料金 | 有料プランで1アカウント月3,000通まで含む。超えた分は1,000通ごとに $0.35 | [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/) |
| 1日の上限 | アカウントごと。新しいアカウントは控えめな1日の枠から始まり、送り方・届き方で自動で上がる。数は公開されていない。超えると、バインディングは `E_DAILY_LIMIT_EXCEEDED` を投げる。早く上げたいときは申請のフォーム | [Limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| 1通の上限 | 宛先は to・cc・bcc を合わせて50、全体で 25 MiB、件名は998文字、独自のヘッダーは合わせて 16 KB | [Limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| バインディングの書き方 | wrangler の設定に `"send_email": [{ "name": "EMAIL" }]`。制限なしなら任意の宛先に送れる。`allowed_sender_addresses` で差出人を、`destination_address`・`allowed_destination_addresses` で宛先を絞れる。差出人は登録した送信ドメインのアドレスでないといけない（違えば `E_SENDER_NOT_VERIFIED`） | [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/) |
| 送り方 | `env.EMAIL.send({ from, to, subject, text, html, replyTo, headers })`。`from` は文字列か `{ email, name }`。戻り値は `{ messageId }`。失敗は `code` を持つ `Error` を投げる（引数の形の誤りは `code` のない `TypeError`） | [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| 失敗の種類 | `E_VALIDATION_ERROR`・`E_FIELD_MISSING`・`E_SENDER_NOT_VERIFIED`・`E_SENDER_DOMAIN_NOT_AVAILABLE`・`E_SENDER_DOMAIN_NOT_CONFIGURED`・`E_EMAIL_SENDING_NOT_READY`（あとで再試行と書かれている）・`E_RECIPIENT_NOT_ALLOWED`・`E_RECIPIENT_PLAN_RESTRICTED`・`E_RECIPIENT_SUPPRESSED`・`E_ACCOUNT_SUSPENDED`・`E_CONTENT_TOO_LARGE`・`E_DELIVERY_FAILED`・`E_RATE_LIMIT_EXCEEDED`・`E_DAILY_LIMIT_EXCEEDED`・`E_INTERNAL_SERVER_ERROR`・ヘッダーの誤り（`E_HEADER_*`）など。どれが一時的かの区分は公式にない | [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| 冪等キー | 書かれていない（Resend の `Idempotency-Key` にあたるものは見つからない） | [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/) |
| 送信ドメインの登録 | 管理画面の Compute → Email Service → Email Sending → Onboard Domain で、Cloudflare のアカウントのドメインを選ぶ。必要な DNS の記録は Cloudflare が足せる（足す前に記録を確かめられる）。Cloudflare の DNS なら5〜15分で終わる | [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/) |
| DNS の記録（送信） | `cf-bounce` のサブドメインに MX（`route1`・`route2`・`route3.mx.cloudflare.net`）・SPF の TXT（`v=spf1 include:_spf.mx.cloudflare.net ~all`）、DKIM の TXT は `cf-bounce._domainkey`（値は Cloudflare が決める）。DMARC は `_dmarc` に、ないときだけ `p=reject` で足す（あれば触らない）。ほかの事業者とは DKIM のセレクターを分け、同じ名前に SPF を2つ置かない | [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)、[Troubleshooting](https://developers.cloudflare.com/email-service/reference/troubleshooting/) |
| バウンス・苦情 | 恒久的なバウンスは再送しない。一時的なバウンスは間隔を広げて再送する。止める宛先の一覧（suppression）を Cloudflare が持つ：恒久的なバウンスは7日（宛先やドメインがないときは期限なし）、一時的なバウンスは24時間、迷惑メールの苦情は期限なし。止めた宛先に送ると `E_RECIPIENT_SUPPRESSED`（「止めた宛先は捨てる」の設定は既定で切） | [llms-full.txt](https://developers.cloudflare.com/email-service/llms-full.txt) |
| 残る記録 | 送信の記録（Activity log）。指標（差出人・宛先・件名・messageId・エラーの詳細などのイベント）は31日問い合わせられる。「Email preview」を入れると、送った本文の控えを約7日残す。2026-07-02 以降に登録した送信ドメインでは最初から入っている。届いた・バウンス・苦情などのイベントを Queues に流せる | [Metrics and analytics](https://developers.cloudflare.com/email-service/observability/metrics-analytics/)、[Event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) |
| ローカル | `wrangler dev` ではバインディングをまねるだけで送らない（中身をログとファイルに残す）。`"remote": true` を付けると本当に送る | [Local development](https://developers.cloudflare.com/email-service/local-development/sending/) |
| データの置き場所 | Email Service の公式の文書に、処理・保管する国の記述は見つからなかった（下の「確認事項」1） | — |
| Terraform | Cloudflare プロバイダ v5 の公式の文書に、送信ドメインのリソースは見つからなかった（Pulumi の v6 に `email_sending_subdomain` がある）。DNS の記録は今の `cloudflare_dns_record` で持てる | [Terraform のリソース一覧](https://developers.cloudflare.com/api/terraform/index.md) |

## API
変えない（利用者に見える API はない）。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| （なし） | | | | | |

## データ
なし（マイグレーションなし）。お知らせの行・日ごとの数の表は変えない。

## 振る舞い

### 1. 送る口を1つにする（実装PR①）
- `apps/api/src/notification/infra/` に、メールを送る口を1つ置く（`mail-sender.ts`）。
  - 形：`send({ to, mail, idempotencyKey }) → { outcome: "sent" | "rejected" | "limited"; code: string }`。一時的な失敗は `MailUnavailable` を投げる（今の `resend.ts` と同じ分け方）。`code` はログに出す短い記号（Resend は状態コードの文字列、Cloudflare は `E_...`・`invalid_argument`・`invalid_from`）。`limited` は Cloudflare の1日の枠に当たったときだけ返す（Resend の実装は返さない）。
  - `application/delivery.ts` の `sendByEmail` は、`sent` なら `'sent'`、`limited` なら `notification_mail_provider_limit`（種類だけ）をログに出して `'limited'`、`rejected` なら今の `notification_mail_rejected`（種類と `code`）をログに出して `'failed'` を返す。
  - Resend の実装（今の `resend.ts`）と Cloudflare の実装（`cloudflare-email.ts`）の2つを置く。
  - `application/delivery.ts` は口だけを呼び、どちらで送るかを知らない。
- どちらで送るかは設定値 `MAIL_PROVIDER`（vars）で決める。`"cloudflare"` なら Cloudflare、それ以外（空・未設定を含む）なら Resend。①では、どの環境も今のまま Resend。
  - 切り替えのために、口を選ぶ関数を1つ置く（`mailSenderFor(env, deps)`）。テストと E2E は `deps.notification` から偽の口を渡せる。
  - E2E の偽の口（`e2eMailSender`。`apps/api/src/e2e/notifications.ts`）は、呼ばれるたびに1行を `e2e_sent_mails` に書き、冪等キーでまとめない（二重送信を隠さない）。
  - E2E の偽の口の名前（`e2eMailSender`）を `apps/api/scripts/check-api-dist.mjs` の禁止パターンに足し、本番のビルドに入らないことを確かめる。
- `domain/` は変えない（`mailFor` の中身・上限の計算はそのまま）。

### 2. Cloudflare の実装
- `env.EMAIL.send()` を呼ぶ。
  - `from`：`MAIL_FROM`（今の `ここ暇 <notify@kokohima.app>`）を `{ email, name }` に分けて渡す。表示名のないアドレスだけの値（`notify@kokohima.app`）なら、文字列の `from` で渡す（`EmailAddress` は `email` と `name` の両方が要るので、`name` を空にして渡さない）。どちらの形でもない値（`<` `>` が欠けた、空など）なら、送らずに一時的でない失敗（`code: "invalid_from"`）にし、設定の誤りとしてログに出す。分ける関数は `domain/` の純粋な関数にして単体テストを書く。
  - `to`：宛先1つ。`subject`・`text`・`html`：`mailFor` の結果そのまま（T-23 の HTML とテキストの両方）。
  - `replyTo`・独自のヘッダー・添付：付けない（今の Resend と同じ）。
- 失敗の分け方（公式に区分がないので、説明から決める。確認事項2）
  - 一時的な失敗（`MailUnavailable` を投げ、Queue の再試行に任せる）：`E_RATE_LIMIT_EXCEEDED`・`E_INTERNAL_SERVER_ERROR`・`E_EMAIL_SENDING_NOT_READY`・`TypeError` でなく `code` もない例外（通信の途切れなど）。
  - 引数の形の誤り（`code` のない `TypeError`。宛先がない、`EmailAddress` の項目が欠けたなど）：再試行しても直らないので、一時的でない失敗（`outcome = 'failed'`、`code: "invalid_argument"`）。
  - 1日の枠（`E_DAILY_LIMIT_EXCEEDED`）：再試行しても同じ日は通らないので、送らずに `outcome = 'limited'` を書く（サービス全体の上限で止めたときと同じ扱い）。ログは `notification_mail_provider_limit`（種類だけ）。
  - それ以外の `code`（宛先が止められている `E_RECIPIENT_SUPPRESSED`、差出人・ドメインの設定の誤り、中身の誤りなど）：一時的でない失敗（`outcome = 'failed'`）。ログは今の `notification_mail_rejected` に `code` を出す。
- 二重に送らないこと：Cloudflare には冪等キーがない（今は Resend が `Idempotency-Key`（お知らせの ID）で1通にまとめている）。
  - 一時的な失敗のうち、送れていないことが確かな `E_RATE_LIMIT_EXCEEDED`・`E_EMAIL_SENDING_NOT_READY` は、そのまま再試行する。
  - 送れたか分からない失敗（`E_INTERNAL_SERVER_ERROR`・`code` のない例外）も再試行する。
  - 今の `deliver` は、`delivered_at IS NULL` を読んでから送り、送ったあとに `markDelivered` を書く。このため、次の場合も2通になる。
    - (a) Queues の at-least-once で、同じお知らせのメッセージが同時に2回走る（どちらも `delivered_at IS NULL` を読んでから送る）。
    - (b) 送れたあと、`markDelivered` かその前後の D1 の書き込みが落ちて、メッセージが再試行になる。
  - 上の3つ（送れたか分からない失敗・(a)・(b)）では、まれに同じメールが2通届くことを受け入れる（届かないことより害が小さい。新しい端末でのログインの知らせを落とさない）。送る前の印（条件付きの UPDATE）は足さない（マイグレーションが要り、印を立てたあとに落ちると届かなくなる）。判断してほしいこと1。
  - 順に2回届いた場合は、今のとおり2回目は `delivered_at` を見て送らない。
- ログ：宛先・件名・本文・`messageId` は出さない（T-07・T-13 のまま）。出すのは種類・`code`・結果だけ。

### 3. wrangler の設定（実装PR①）
- すべての環境（既定・`e2e`・`assets`・`staging`・`prod`）に `send_email` のバインディング `EMAIL` を足す（バインディングは環境に引き継がれないため）。
  - `prod`：`allowed_sender_addresses: ["notify@kokohima.app"]` を付け、ほかの差出人では送れないようにする。宛先は絞らない（利用者の誰にでも送るため）。
  - `staging`：`notify@staging.example.invalid`（今の `MAIL_FROM` と同じ）。staging はデプロイしない（T-12）。
  - ローカル・`e2e`・`assets`：`wrangler dev` がまねるだけで送らない。`remote` は付けない。
- `MAIL_PROVIDER` を vars に足す。①では全環境 `"resend"`。
- `env.ts` の `Bindings` に `EMAIL`（`SendEmail`）と `MAIL_PROVIDER` を足す。
- 変更は `infra-change` スキルに従う。`pnpm --filter api build:prod` で本番のビルドが通ることを確かめる。

### 4. 上限
- 1日・1人の上限（T-07 決定事項8）と、サービス全体の1日の上限 `MAIL_DAILY_LIMIT`（prod は90）は変えない。Cloudflare の1日の枠の数が分かるまで今のまま保つ。
  - 新しい端末でのログインの知らせは、`MAIL_DAILY_LIMIT` の外（`globalEmailLimitFor` が `null`）で、超えていても送る。このため月の通数は 90通×日数（30日で2,700通）を超えうる。有料プランに含まれる月3,000通を超えた分は、1,000通ごとに $0.35 の従量の課金になる（一般公開の前の今の数では超えない見込み）。
- Cloudflare の枠に当たったとき（`E_DAILY_LIMIT_EXCEEDED`）は、2.のとおり `limited` にして一覧にだけ残す。サービスの上限の外にある新しい端末でのログインの知らせも、Cloudflare の枠では `limited` になり届かない（今の Resend では、429 は再試行になる）。
- T-07 の `MAIL_DAILY_LIMIT` の説明（「Resend の無料枠の1日100通より少し下」）は、実装PR④で「Cloudflare の月の枠に収まる値」に直す。

### 5. 差出人と中身
- 差出人のアドレス `notify@kokohima.app` と表示名「ここ暇」は変えない。
- メールの中身（件名・HTML・テキスト。種類の短い説明だけで、相手の名前などを入れない。新しい端末でのログインだけ端末の要約と日時）は変えない（T-07 決定事項6・T-23）。

### 6. DNS（実装PR②。Terraform）
- 持ち主が管理画面で `kokohima.app` を送信ドメインに登録する（下の「人が行う作業」1）。このとき Cloudflare が `cf-bounce` の MX・SPF・DKIM を足す（DKIM の値は登録してから決まるので、先に Terraform では書けない）。DMARC は今の記録（`p=none`）があるので Cloudflare は触らない。
- 足された記録を、`infra/terraform/envs/prod/dns.tf` に `cloudflare_dns_record` で書き、`import` ブロックで取り込む（Terraform で DNS を持つ決まりを保つ。infra/README.md「DNS の例外」）。`plan` で、置き換え・削除がなく、変わるのが `comment` だけ（Cloudflare が足した記録には、今の Resend の記録と同じ「…dns.tf で管理」の `comment` がない）であることを確かめて PR に貼る。
  - 記録の ID・値・TTL と、MX の `priority`（v5 の `cloudflare_dns_record` では MX に必須）は、持ち主から受け取る（Claude は管理画面に入らない）。`ttl` と `priority` は受け取った値をそのまま書く。リソースは Resend と別の `local`（`cloudflare_email_records`）と別の `resource`（`cloudflare_dns_record.cloudflare_email`）にする。
  - Resend の記録（`resend._domainkey`・`send`・`rsend`）は移行が終わるまで残す。名前が重ならないので共存できる（DKIM のセレクターも SPF の名前も別）。
  - DMARC は今のまま（`p=none`）。
- ①より先に持ち主が登録を済ませていれば、②を①と同じ PR にしてよい。
- `apply` は持ち主が行う。

### 7. 切り替え（実装PR③）
- prod の `MAIL_PROVIDER` を `"cloudflare"` にする（コードの既定も Cloudflare にし、空・未設定を Cloudflare として扱う）。
- 同じ PR で、プライバシー ポリシーの本文の5.の Cloudflare の「任せること」に「メールの配信」を足す（T-19「9.」。渡すものは今も「このサービスのすべての情報」）。Resend の節は、まだ残す（戻すことがあるのと、Resend に送信の記録が残っているため）。改定日はマージしてデプロイする日（T-19 決めたこと17。予告なし）。`legal.test.tsx` の文の検査も直す。
  - `legal.test.tsx` はページが T-19 の仕様書の6節の文案と全文で同じことを確かめるので、同じ PR で `docs/specs/T-19-privacy-terms.md` の本文の文案の5.の Cloudflare の「任せること」も同じ文に直す。
- デプロイのあと、持ち主が届くことを確かめる（下の「人が行う作業」3）。届かなければ `MAIL_PROVIDER` を `"resend"` に戻す1行の PR で戻す（判断してほしいこと2）。
- 要求定義書（`docs/requirements.md`）の図の「メール配信（Resend）」と技術選定の「メール配信」の行も、この PR で Cloudflare Email Service に直す（「Cloudflareのメール機能は任意宛先の通知向きではない」は事実でなくなったので消す）。

### 8. Resend を外す（実装PR④。③を確かめたあと）
- コード：`resend.ts`、口の Resend の実装と `MAIL_PROVIDER` の分岐（`MAIL_PROVIDER` も消す）、`env.ts` の `RESEND_API_KEY`・`deps.notification.resendUrl`、`app.ts`、`test/fake-delivery.ts` の偽の Resend、`apps/api/src/e2e/notifications.ts` の偽のホスト `resend.e2e.invalid`（偽の口に置き換え済み）、`vitest.config.ts` の `RESEND_API_KEY`、wrangler の設定のコメント、`apps/api/dev-vars.example` の `RESEND_API_KEY`、`apps/api/scripts/write-e2e-dev-vars.mjs` の `RESEND_API_KEY=e2e-unused`、`apps/api/scripts/check-api-dist.mjs`・`check-web-dist.mjs` の禁止パターンの `resend.e2e.invalid`（`e2eMailSender` は残す）。
- DNS：`dns.tf` から Resend の記録を外す。DMARC は同じ `for_each` の中にあるので、`moved` ブロックで Resend と別のリソースに移し、消して作り直さない（`plan` で DMARC の削除が出ないことを確かめる）。
- プライバシー ポリシー：本文の5.の Resend の節、7.の事業者の並び・外国の名称・確かめ方の「Resend」を外す。`legal.test.tsx` を直す。同じ PR で、`docs/specs/T-19-privacy-terms.md` の本文の文案（5.の Resend の節、7.の事業者の並び・外国の名称・確かめ方の Resend の行）も同じに直す。改定日はデプロイする日（予告なし）。
- 仕様書・文書：T-07（「外部とのつなぎ方」「メールの中身」の送信の行、「設定値」、決定事項1 の注記）、T-23（「API」の送信の行）、T-12（「人が行う作業」4 の注記）、T-16（「スコープ外」の外部サービス）、T-08（外部呼び出しの一覧）、T-19（本文の出典の表、確認事項5 の注記）、`docs/runbooks/monitoring.md`（Resend の管理画面→Cloudflare の Email Sending の画面、`code`）、`infra/README.md`「DNS の例外」。どれも書き換えた日と T-59 を変更履歴に足す。
- 秘密情報：持ち主が `wrangler secret delete RESEND_API_KEY --env prod` を行い、Resend の API キーを失効させる。
- Resend のアカウント：持ち主が送信ドメインを外し、アカウントを消すかを決める（送信の記録が残る期間は T-19 確認事項5・#89）。

### 9. どの PR で何を直すか

| PR | 中身 | 仕様書・文書 | プライバシー ポリシー |
| --- | --- | --- | --- |
| ① 実装 | 送る口、Cloudflare の実装、`EMAIL`・`MAIL_PROVIDER`（全環境 Resend）、偽の口、単体テスト | T-07 の「外部とのつなぎ方」に送る口と2つの実装、「設定値」に `MAIL_PROVIDER`・`EMAIL`。`docs/runbooks/monitoring.md` に `notification_mail_provider_limit` と `code` | 直さない（送る先は変わらない） |
| ② インフラ | `dns.tf` に Cloudflare の記録（`import`） | `infra/README.md`「DNS の例外」の例に Cloudflare Email Service を足す | 直さない |
| ③ 切り替え | prod とコードの既定を Cloudflare に | `docs/requirements.md`（図・技術選定）、T-07 決定事項1 に「T-59 で Cloudflare に移した」の注記、T-19 本文の文案の5.の Cloudflare | 5.の Cloudflare に「メールの配信」を足す |
| ④ 後片付け | Resend のコード・秘密・DNS を外す | 8.の一覧（T-19 本文の文案の5.の Resend の節、7.の並び・外国の名称・確かめ方を含む） | 5.・7.から Resend を外す |

- T-59 の仕様書は①で「実装中」にし、④で「実装済み」にする。各 PR の変更履歴に足す。

## 認可と秘匿
- 閲覧者IDの使い方：変えない（お知らせの受け取り手は T-07 のとおり）。
- 他人のデータに届かないことの保証：API を足さない。送る宛先は、受け取り手本人のメールアドレス（`getNotificationAddress`）だけ。
- 区別させない応答：利用者に見える応答は変えない。
- 秘密情報：Cloudflare の送信はバインディングなので、API キーを持たない（④で `RESEND_API_KEY` を消す）。
- prod のバインディングは差出人を `notify@kokohima.app` に絞る（コードの誤りで別の差出人から送れないように）。
- Cloudflare に残るもの：送信の記録（宛先・件名など）と、「Email preview」を入れていれば本文の控え（約7日）。本文の控えは要らないので切る（「人が行う作業」2）。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 正常系：`MAIL_PROVIDER = "cloudflare"` で、偽のバインディングの `send` に `from: { email: "notify@…", name: "ここ暇" }`・宛先1つ・件名・`text`・`html` が渡り、`outcome = 'sent'` になる
- [ ] 正常系：`MAIL_PROVIDER` が `"resend"`（①）なら今のテスト（偽の Resend）のまま通る
- [ ] 口の選び方（`mailSenderFor`）：`MAIL_PROVIDER` が `"cloudflare"`・`"resend"`・空・未設定のとき。①では `"cloudflare"` だけ Cloudflare、ほかは Resend。③では `"resend"` だけ Resend、ほかは Cloudflare
- [ ] 失敗の分け方：`E_RATE_LIMIT_EXCEEDED`・`E_INTERNAL_SERVER_ERROR`・`E_EMAIL_SENDING_NOT_READY`・`TypeError` でない `code` のない例外は再試行（`MailUnavailable`）。再試行で送れたら `sent` で1通
- [ ] 失敗の分け方：`code` のない `TypeError` は `failed`（`code: "invalid_argument"`）で、再試行しない
- [ ] 失敗の分け方：`E_DAILY_LIMIT_EXCEEDED` は `limited`、`notification_mail_provider_limit` がログに出る、日ごとの数は戻さない。新しい端末でのログインの知らせも `limited`
- [ ] 失敗の分け方：`E_RECIPIENT_SUPPRESSED`・`E_SENDER_NOT_VERIFIED` は `failed`、ログに `code` が出て宛先・件名が出ない
- [ ] 入力検証：`MAIL_FROM` を分ける関数。表示名つき（`ここ暇 <notify@…>`）は `{ email, name }`、アドレスだけは文字列の `from`、`<` `>` が欠けた値・空は `invalid_from`（`send` を呼ばず `failed`）
- [ ] 境界値：届け終えたお知らせを2回目に受けても `send` を呼ばない
- [ ] 境界値：同じお知らせの `deliver` を並行して2回呼んだとき、`send` は2回まで呼ばれてよい（2通を許す。2.の (a)）。お知らせの行の `outcome` は `sent` で、エラーにならない
- [ ] 他人のIDでは取得できない：API を足さないので既存のテストのまま。宛先が受け取り手本人のアドレスだけであることを確かめる
- [ ] 上限：今の上限のテスト（1人・全体）が Cloudflare の口でも通る

### E2Eテスト（対象にする利用者の流れ）
- [ ] 既存の「誘いのお知らせ（メール）」「新端末のログイン」を、偽の口（`e2e_sent_mails` に書く）で通す。E2E の偽のメールは送る口の手前で差し替えるので、Resend か Cloudflare かによらない。偽の口は冪等キーでまとめないので、二重に送れば2行になる。新しい流れは足さない（利用者の流れは変わらない）

## 人が行う作業（持ち主）
1. 送信ドメインの登録（②の前）：管理画面の Compute → Email Service → Email Sending → Onboard Domain で `kokohima.app` を選ぶ。足す前に記録を確かめ、DMARC を足そうとしていないこと（今の `p=none` を残すこと）を見る。登録のあと、DNS の画面で `cf-bounce` の MX 3つ・SPF・DKIM の記録の ID・値・TTL と、MX の priority を Claude に渡す。
2. 「Email preview」を切る（③の前）：送った本文の控えを Cloudflare に残さない。
3. 届くかの確認（③のデプロイのあと）：持ち主の手元のアドレスで、Gmail・iCloud（iOS のメール）・Outlook.com・キャリアのメール（docomo・au・SoftBank のどれか）と、Apple の中継アドレス（Sign in with Apple を使う人の宛先。今は Apple のログインを止めているので、使えるときだけ）に、次の2つを送って確かめる。
   - 新しい端末でのログイン（別のブラウザでログインする）
   - 誘いのお知らせ（プッシュを切った端末あてに誘う）
   - 見ること：受信トレイに入るか（迷惑メールに入らないか）、差出人が「ここ暇 <notify@kokohima.app>」か、HTML が崩れないか、ヘッダーの `Authentication-Results` で SPF・DKIM・DMARC が `pass` か。
   - 結果は③の PR か、その次の PR の説明に書く（アドレスは書かない）。
4. 届かない・迷惑メールに入るとき：`MAIL_PROVIDER` を `"resend"` に戻す PR をマージしてデプロイする（戻すのは vars の1行）。
5. Resend の片付け（④のあと）：`wrangler secret delete RESEND_API_KEY --env prod`、Resend の API キーの失効、送信ドメインの削除、アカウントを消すか。
6. Cloudflare の1日の枠：管理画面か申請で今の枠を確かめ、`MAIL_DAILY_LIMIT` を見直すかを決める（確認事項3）。

## スコープ外
- バウンス・苦情のイベントを Queues で受けて、アプリの側でメールを止めること（Cloudflare の止める宛先の一覧に任せる）。
- メールの受信（Email Routing）。運営の問い合わせ先 `ops@kokohima.app` の受け方は変えない。
- メールの中身・送る条件・1日の上限の数の変更。
- `staging` のデプロイ（T-12 のとおりしない）。
- BIMI（T-51）。

## 確認事項（合意前に解消する）
1. **データの置き場所**：Email Service の公式の文書に、処理・保管する国の記述が見つからなかった。Cloudflare のデータ処理に関する契約（DPA）が Email Service にも及ぶことと、置き場所を「Cloudflare が選ぶ。前もって特定できない」（本文の7.の今の書き方）で足りることを、③の前に持ち主が確かめる。足りなければ③で本文の7.を直す。
2. **失敗の分け方**：一時的な失敗を `E_RATE_LIMIT_EXCEEDED`・`E_INTERNAL_SERVER_ERROR`・`E_EMAIL_SENDING_NOT_READY` と `code` のない例外にした。公式に区分がないので、①の実装で `@cloudflare/workers-types` の型と、ローカルのまねの動きを見て、違えば仕様書を直す。`E_DELIVERY_FAILED` は一時的でない失敗にした。
3. **1日の枠の数**：新しいアカウントの枠の数は公開されていない。90通より小さければ、`E_DAILY_LIMIT_EXCEEDED` で `limited` になる。持ち主が管理画面で確かめる（「人が行う作業」6）。
4. **ベータであること**：公開ベータなので、API・上限・料金が変わりうる。④（Resend を外す）は、③のあと少なくとも7日、`notification_mail_rejected`・`notification_mail_provider_limit` が出ないことを見てから行う。
5. **Terraform の送信ドメインのリソース**：プロバイダ v5 に送信ドメインのリソースがあるかを、②で公式のスキーマで確かめる。あれば、登録そのものも Terraform で持つかを②の PR で決める。
6. **wrangler とワーカーの型**：`send_email` のバインディングの `send({ from, to, … })` の形（`EmailMessageBuilder`）が、今の `wrangler`（^4.161）と `@cloudflare/workers-types`・`@cloudflare/vitest-pool-workers` で使えるかを①で確かめる。使えなければ版を上げる。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-28 | 初版 | 持ち主の依頼（メールを Cloudflare Email Service に移す） |
| 2026-11-28 | 二重送信の経路（同時の2回・送ったあとの書き込みの失敗）と偽の口がまとめないこと、口の型に `limited`、`TypeError` と `MAIL_FROM` の扱い、T-19 の文案を直す PR、④のファイルの一覧と `e2eMailSender` の検査、DNS の取り込み（priority・TTL・comment）、上限とログインの知らせ、`mailSenderFor` のテストを書き足した | PR #234 のレビュー |
