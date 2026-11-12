---
name: calendar-integration
description: Google/Appleカレンダー連携（calendarコンテキスト）を変更するときのルール。腐敗防止層、取得範囲、トークンの扱い
---
# カレンダー連携

- calendarコンテキストは腐敗防止層。外部の形式（Google APIのレスポンス、CalDAV/iCalendar）をdomainへ持ち込まず、「この時間が埋まった」「予定を書き込む」に変換する
- プロバイダは共通インターフェースの実装として追加する（google/、caldav/）
- 取得するのは空き／埋まりのみ。予定のタイトル・場所・参加者は読まない・保存しない
- Googleのスコープは `calendar.freebusy`（空き／埋まり）と `calendar.app.created`（アプリが作る「ここ暇」カレンダー）の2つだけ。埋まりは `primary` だけで確かめる（docs/specs/T-06-calendar.md）
- OAuthトークンとAppleのアプリ用パスワードは暗号化して保存（`shared/crypto.ts` の `encryptSecret`。AAD に持ち主）。連携解除時は提供元でも失効させる。ただし revoke はプロジェクトの許可全体を失効させるので、使っている連携があるときは失効させない（連携し直し・スコープ不足）
- 外部呼び出しはタイムアウト・再試行上限・バックオフを必ず付ける。失敗しても誘いの機能は止めない
- Googleの変更通知（Webhook）は使わない（`calendar.freebusy` では見張れない）。15分ごとの確認で、新しく入った埋まりだけで取り消す
- 外部とのやり取りは `CalendarProvider`（`calendar/domain/provider.ts`）を通す。E2E では `AppDeps.google.endpoints` を偽の経路に向ける
