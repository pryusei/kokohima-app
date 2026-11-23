# T-26 仕様書：BIMI（通知メールに「ここ暇」のロゴを出す）

- 状態：下書き
- タスク票：docs/tasks/T-26-bimi.md
- 関係する要件：要求定義書「セキュリティ設計」（通知メールの SPF・DKIM・DMARC）、F-16（通知）。T-07「メールの送信」、T-12「人が行う作業」4

## 概要
通知メールは Resend から `ここ暇 <notify@kokohima.app>` で送っている（T-07）。BIMI（Brand Indicators for Message Identification）を登録すると、対応するメールアプリで差出人の横に「ここ暇」のロゴが出る。見知らぬ差出人に見えにくくなり、通知メールが開かれやすく、なりすましと見分けやすくなる。BIMI は **DMARC を `quarantine` 以上にしていることが前提**なので、今の `p=none`（監視だけ）を上げる作業が先に要る。DNS は Terraform（`infra/terraform/envs/prod/dns.tf`）で持ち、ロゴは Workers の静的ファイルで配信する。

## 決めたこと
1. **順番は「DMARC を上げる → ロゴを置く → 証明書を取る → BIMI の記録を足す」。** 手前が済んでいないと次は効かない（BIMI の記録を先に足しても、DMARC が `p=none` なら何も出ない）。各段階を別の実装PR（または人の作業）に分け、1つずつ戻せるようにする。
2. **証明書（VMC か CMC）は、人が取る。** Gmail は証明書がないとロゴを出さない。Apple Mail は VMC が必要。VMC は登録商標が要り、CMC は商標なしでも取れるが、Gmail にしか効かず、ロゴを実際に使ってきた証拠（目安は12か月）が要る。どちらにするか、そもそも取るかは確認事項1。証明書の発注・支払い・ドメイン認証は人が行い、Claude は行わない。
3. **ロゴは今のアイコンと別に、BIMI 用の SVG を作る。** BIMI のロゴは SVG Tiny PS（`baseProfile="tiny-ps"`、`version="1.2"`、`<title>` あり、スクリプト・外部参照・アニメーションなし、正方形、32KB 以下）でなければならない。アプリのアイコン（`apps/web/public/icon.svg`）は PWA 用に角丸の `rect` で、そのままは使えない。`apps/web/public/bimi/logo.svg` に新しく置く。色は T-25 のアイコンと揃える。
4. **BIMI の記録は `default._bimi.kokohima.app`（TXT）。** `v=BIMI1; l=<ロゴのURL>; a=<証明書のURL>`。ロゴ・証明書は HTTPS の `https://kokohima.app/bimi/` から配信する。証明書のファイル（`.pem`）は公開してよい情報で、秘密ではない。秘密鍵は発行の過程で人が持つものでここには出てこない。
5. **DMARC の `quarantine` へは、レポートを見てから段階的に上げる。** `p=none` のまま `rua` がない今は、何が失敗しているか見えない。先に `rua` を足してレポートを受け、Resend 以外に `kokohima.app` を名乗る送信元がないことを確かめてから、`p=quarantine; pct=25` → `50` → `100` と上げる（確認事項2）。BIMI は `pct=100` で `quarantine` 以上が条件。
6. **アプリの挙動は変えない。** メールの本文・差出人（`MAIL_FROM`）・通知の仕組みは変更しない。API・D1 の変更もない。

## 変更するもの（実装PR）
| 段階 | 変更 | 担当 |
| --- | --- | --- |
| A | `dns.tf` の DMARC を `rua` つきにし、段階的に `p=quarantine; pct=100` へ | 実装PR（Terraform）。`apply` は人 |
| B | `apps/web/public/bimi/logo.svg`（SVG Tiny PS）。SPA のフォールバックが画面を返さず、`Content-Type: image/svg+xml` で返ること | 実装PR |
| C | 証明書（VMC か CMC）の取得。`apps/web/public/bimi/vmc.pem` に置く | 人 |
| D | `dns.tf` に `default._bimi.kokohima.app` の TXT を足す | 実装PR（Terraform）。`apply` は人 |

`dns.tf` の変更は `infra-change` スキルに従う（Cloudflare プロバイダ v5 の `cloudflare_dns_record` のスキーマを公式ドキュメントで確かめる、`terraform fmt`・`validate`、`plan` の結果を PR に貼る、`apply` はしない）。

## 振る舞い
- ロゴの URL（`/bimi/logo.svg`）は認証なしで取れる（メールアプリが取りに来る）。Workers の静的ファイルとして返し、API ルートの外に置く。
- CSP・セキュリティのヘッダー（T-12）は画面の応答のためのもの。`/bimi/*` は画像として返るだけで、既存の CSP を緩めない。
- ロゴ・証明書の URL を変えたら、BIMI の記録も同じ PR で直す。

## 認可と秘匿
- 閲覧者IDの使い方：なし。個人のデータを扱わない。
- 他人のデータに届かないことの保証：API・D1 を足さない。公開するのはロゴと証明書の公開部分だけ。
- 区別させない応答：該当なし。
- DMARC のレポート（`rua`）には、送信元の IP とメッセージ数が含まれる。受信先は運営の管理下のものにし、利用者の個人情報は入らない（メールアドレスや本文は含まれない集計）。レポートの受信先のアドレスをリポジトリに書くかどうかは確認事項2。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] `apps/web/public/bimi/logo.svg` が SVG Tiny PS の条件を満たす：`baseProfile="tiny-ps"`・`version="1.2"`・`<title>` がある、`<script>`・`<image>`・`href` の外部参照・`style` の外部読み込みがない、`viewBox` が正方形、32KB 以下
- [ ] `dns.tf` の BIMI の記録の `l=`・`a=` の URL が、実際に置いたファイルのパスと一致する（Vitest でファイルの存在と記録の文字列を突き合わせる）
- [ ] 他人のIDでは取得できない：対象外（個人のデータを扱う API を足さない）

### E2Eテスト
- 対象なし。画面・利用者の流れを変えず、メールアプリ側の表示はこちらから自動で確かめられない（確認事項3の実機確認を人が行う）。

### 人が行う確認（マージ後）
- `dig TXT default._bimi.kokohima.app`・`dig TXT _dmarc.kokohima.app` で記録が出る
- BIMI Group の検査（<https://bimigroup.org/bimi-generator/> の Inspector）で、記録・ロゴ・証明書がすべて通る
- Gmail・Apple Mail の実機で、通知メールにロゴが出る（反映に数日かかることがある）

## スコープ外
- アプリのアイコン（T-25）の変更
- メールの本文・デザイン（T-23）の変更、差出人の変更
- 商標の出願・登録そのもの

## 確認事項（合意前に解消する）
1. **証明書をどうするか。** 「ここ暇」は商標登録していますか（VMC には登録商標が要る）。していなければ、(a) CMC で Gmail だけに出す、(b) 商標を出願して VMC を待つ、(c) BIMI はやらない、のどれにするか。証明書は年単位の費用がかかるので、友達とのクローズド運用の段階で要るかも含めて決める。
2. **DMARC の `rua` の受信先。** 運営のメールアドレスを使うか、DMARC のレポートを集計して見せるサービスを使うか。`kokohima.app` を名乗る送信元が Resend 以外にないか（Cloudflare Email Routing など）も確かめる。
3. **実機で何を確かめるか。** 運営が使っている Gmail・iOS のメールアプリのどれで確認するか。
4. **BIMI 用のロゴのデザイン。** 今のアイコン（黄の角丸に白い円）をそのまま使うか、別に作るか。SVG Tiny PS にできる形（グラデーション・フィルターなし）であること。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 初版（下書き） | 通知メールにロゴを出したい（BIMI の登録） |
