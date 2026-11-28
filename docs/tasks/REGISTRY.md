# タスク番号の台帳

タスクID（`T-xx`）は、この台帳で取る。T-12・T-26・T-28・T-30 で、別々の作業が同じ番号を使ってしまったため（pryusei/kokohima-app#198）。

## 番号の取り方
1. 下の「使っている番号」の一番大きい番号の次を、**次に使える番号**として取る（今は **T-61**）。
2. 仕様書やタスク票を書く前に、この表に1行足す PR を出すか、仕様書PRの最初のコミットで行を足す。どちらでも、**main に先に入った方がその番号を持つ**。
3. 取った PR がマージされる前に main で同じ番号が使われたら、取り直す（番号を変えて、表の行も直す）。
4. 欠番は詰めない。やめたタスクも行を残し、状態を「やめた」にする。
5. issue だけで番号を予約してもよい（状態「予約」）。予約は issue のタイトルに番号を書く。

## 使っている番号

状態：済み＝実装まで main に入った／仕様書＝仕様書だけ main に入った／作業中＝PR が開いている／予約＝issue だけ／保留／やめた

| ID | 名前 | 状態 | 仕様書・タスク票 | issue・PR |
| --- | --- | --- | --- | --- |
| T-00 | IaC の技術検証 | 済み | docs/tasks/T-00-iac-spike.md | |
| T-01 | 認証 | 済み | docs/specs/T-01-auth.md | |
| T-02 | 友達と招待リンク | 済み | docs/specs/T-02-friends.md | |
| T-03 | ここ暇 | 済み | docs/specs/T-03-availability.md | |
| T-04 | 個別の誘い | 済み | docs/specs/T-04-direct-invite.md | |
| T-05 | 募集 | 済み | docs/specs/T-05-broadcast.md | |
| T-06 | カレンダー連携（Google）と .ics | 済み | docs/specs/T-06-calendar.md | |
| T-07 | 通知 | 済み | docs/specs/T-07-notification.md | |
| T-08 | リンクのプレビュー（OGP） | 済み | docs/specs/T-08-link-preview.md | |
| T-09 | Apple カレンダー連携（CalDAV） | 保留 | docs/tasks/T-09-apple-caldav.md | |
| T-10 | 冪等キー・キャッシュ・回数の上限 | 済み | docs/specs/T-10-idempotency-cache-ratelimit.md | |
| T-11 | 画面の最終デザイン | 済み | docs/specs/T-11-design.md | |
| T-12 | データの増加への備え | 済み | docs/specs/T-12-data-growth.md | **重複**（下の「重なり」） |
| T-12 | Web としての最初のリリースの準備 | 済み | docs/specs/T-12-release.md | **重複**（下の「重なり」） |
| T-13 | 監視とアラート | 済み | docs/specs/T-13-monitoring.md | |
| T-14 | 「みんな」の空きの回数の上限 | 済み | docs/specs/T-14-friend-availabilities-ratelimit.md | |
| T-15 | 初回設定 | 一部は T-31 へ移った | docs/specs/T-15-onboarding.md | |
| T-16 | 退会 | 済み | docs/specs/T-16-withdrawal.md | |
| T-17 | 古いデータの掃除と保持期間 | 済み | docs/specs/T-17-retention.md | |
| T-18 | 画面（PWA）のエラーの収集 | 仕様書（下書き） | docs/specs/T-18-client-errors.md | |
| T-19 | プライバシー ポリシーと利用規約 | 済み | docs/specs/T-19-privacy-terms.md | |
| T-20 | PC で見るための画面の配置 | 済み | docs/specs/T-20-desktop-layout.md | |
| T-21 | iPhone の Safari で E2E | 済み | docs/specs/T-21-webkit-e2e.md | |
| T-22 | 行きたいリスト | 済み | docs/specs/T-22-wishlist.md | |
| T-23 | リッチな HTML メール | 済み | docs/specs/T-23-rich-mail.md | |
| T-24 | 問い合わせのフォーム | 済み | docs/specs/T-24-contact.md | |
| T-25 | ホーム画面に追加しやすくする | 済み | docs/specs/T-25-installable-pwa.md | |
| T-26 | 脆弱性スキャンのエッジでの遮断 | 済み | docs/specs/T-26-wp-scan-block.md | |
| T-27 | アイコン画像のアップロード | 済み | docs/specs/T-27-avatar-upload.md | |
| T-28 | LINE で送る | 済み | docs/specs/T-28-line-share.md | |
| T-29 | 行きたいの AI 提案 | 済み | docs/specs/T-29-wish-suggestion.md | |
| T-30 | CI の見直し | 済み | docs/specs/T-30-ci-review.md | #175・#177 |
| T-31 | 表示名の必須化と友達になった直後の画面 | 済み | docs/specs/T-31-display-name-first-step.md | #179・#203 |
| T-32 | LINE ログイン | 済み | docs/specs/T-32-line-login.md | #180 |
| T-33 | ブロックと通報 | 済み | docs/specs/T-33-block-report.md | #181 |
| T-34 | 「ここどう？」の入口 | 済み | docs/specs/T-34-kokodou-entry.md | #182・#202 |
| T-35 | 通知の見え方を本人が選ぶ | 済み | docs/specs/T-35-notification-visibility.md | #183 |
| T-36 | プライバシー ポリシーと規約の改定 | 予約 | | #184 |
| T-37 | 誘いから始まる招待 | 予約 | | #185 |
| T-38 | 輪のリンク | 予約 | | #186 |
| T-39 | LINE グループに貼る募集 | 予約 | | #187 |
| T-40 | 「今ひま」ワンタップ | 済み | docs/specs/T-40-ima-hima.md | #188 |
| T-41 | 学生向けの時間帯プリセット | 予約 | | #189 |
| T-42 | すべての断りに同じ一文 | 予約 | | #190 |
| T-43 | 成立の演出（思い出カードは別に再検討） | 済み | docs/specs/T-43-meet-moment.md | #191 |
| T-44 | ログインなしで読める紹介のページ | 作業中 | docs/specs/T-44-landing.md | #192・#199。仕様書 #219、実装PR #222 |
| T-45 | インスタのストーリーズ・DM への共有 | 予約 | | #193 |
| T-46 | 「この時間なら」のカードとフォーカスの輪 | 済み | docs/specs/T-46-countered-card-focus-ring.md | #194・#204 |
| T-47 | アクセシビリティとトークンの直し | 予約 | | #195 |
| T-48 | 公開の前に塞ぐ上限と秘匿の穴 | 予約 | | #196 |
| T-49 | 性能の小さな直し | 済み | docs/specs/T-49-perf-small-fixes.md | #197・#206 |
| T-50 | CI とマージの関門・この台帳 | 作業中 | docs/tasks/REGISTRY.md | #198 |
| T-51 | BIMI（通知メールにロゴを出す） | 作業中（旧 T-26） | | #153 |
| T-52 | バージョンの管理とリリースのタグ | 作業中（旧 T-28） | | #136 |
| T-53 | 公式の X と Instagram | 作業中（旧 T-30） | | #176 |
| T-54 | 保存できたことをボタンで伝える・退会のあとの一文 | 済み | docs/specs/T-54-save-and-goodbye-copy.md | |
| T-55 | ここ暇タブを週の帯に作り直す | 済み | docs/specs/T-55-availability-week-grid.md | #217 |
| T-56 | 画面の動きと手触り | 作業中 | docs/specs/T-56-motion.md | 仕様書 #216。実装PR①（土台とシート）が作業中 |
| T-57 | 成立した予定から Google カレンダーに入れる | 済み | docs/specs/T-57-meetup-google-calendar.md | 仕様書 #225・実装 #228・直し #229 |
| T-58 | 成立の演出の丸にアイコンの画像を出す | 作業中 | docs/specs/T-58-meet-moment-avatars.md | 仕様書 #227・実装 #230 |
| T-59 | 成立した予定は、本人が選んでカレンダーに入れる | 作業中 | docs/specs/T-59-choose-calendar-add.md | |
| T-60 | メールの送信を Cloudflare Email Service に移す | 仕様書 | docs/specs/T-60-cloudflare-email.md | 仕様書 #234（T-59 から番号を変えた） |

## 重なり（番号が2回使われたもの）

| 番号 | 先に main に入ったもの | あとのもの | 扱い |
| --- | --- | --- | --- |
| T-12 | データの増加への備え | Web としての最初のリリースの準備 | どちらも main に入っているので番号は変えない。参照するときはファイル名（`T-12-data-growth`・`T-12-release`）で区別する |
| T-26 | 脆弱性スキャンのエッジでの遮断 | BIMI（#153。まだマージされていない） | BIMI を **T-51** にする。#153 を次に触るときにファイル名とタイトルを直す |
| T-28 | LINE で送る | バージョンの管理とリリースのタグ（#136。まだマージされていない） | **T-52** にする。#136 を次に触るときに直す |
| T-30 | CI の見直し | 公式の X と Instagram（#176。まだマージされていない） | **T-53** にする。#176 を次に触るときに直す |

番号のないもの：LINE ミニアプリ（保留。#201）、人の作業（Google の審査 #199、友達への聞き取り #200）。
