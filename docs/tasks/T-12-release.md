# T-12 Web としての最初のリリースの準備

## 目的
友達だけ（100人まで）に向けて、ここ暇を Web アプリ（PWA）として `https://kokohima.app` で使えるようにする準備をする。画面と API を同じ Worker・同じオリジンから出し、ログインは Google だけにし、ブラウザ向けのセキュリティのヘッダーを付ける。

## 関係する要件
- 要求定義書「残りの論点」MVP（友達とのクローズド運用）までに必須：XSS対策（エスケープ、Content-Security-Policy）
- 要求定義書「AI時代の攻撃を前提にした運用」：外に出ている窓口を一覧にし、使わないルートは閉じる
- F-01（ログイン）：最初のリリースでは Google だけ（利用者と決めた。Apple Developer Program を使わない）
- issue：pryusei/kokohima-app#42（アプリの中で行う CSP・HSTS の部分）、#52（本番までに人が行う作業）

## スコープ
- やること：
  - `apps/web` のビルドを、API と同じ Worker の静的アセットとして出す（同じオリジン）
  - 画面の応答と API の応答に、セキュリティのヘッダーを付ける
  - Sign in with Apple を設定で止める（API の経路を閉じ、画面のボタンを出さない。コードは残す）
  - staging・prod の wrangler の設定を、ドメイン `kokohima.app` に合わせる（カスタムドメイン、`APP_ORIGIN`、`LINK_PREVIEW_OWN_DOMAINS`、`MAIL_FROM`、`workers.dev` を閉じる）
  - 本番のビルドの検査を、画面を含めた形にする
  - #52 の人が行う作業の一覧を、この形に合わせて書き直す
- やらないこと（スコープ外）：
  - `wrangler deploy`・`terraform apply`・secret の設定・Google と Resend の管理画面の設定（人が行う）
  - アプリストアへの公開、Apple カレンダー（T-09）、Apple のログイン
  - WAF・ボット対策などエッジの設定（#42 の残り）、退会（#37）、掃除（#38）
  - 画面のデザイン（T-11）

## 受け入れ条件
- [ ] 本番の設定では、`https://kokohima.app/` で画面が、`https://kokohima.app/api/v1/...` で API が、同じ Worker から出る。画面の経路（`/invites/xxx` など）を直接開いても画面が出る
- [ ] 画面と API の応答に、仕様書のセキュリティのヘッダーが付く
- [ ] Apple のログインを止めた環境では、Apple の経路が使えず、画面に「Appleでログイン」が出ない
- [ ] 本番のビルドに、画面のファイルが含まれ、E2E 用の名前が含まれない
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-12-release.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 関係するスキル：infra-change、api-conventions、e2e-testing
