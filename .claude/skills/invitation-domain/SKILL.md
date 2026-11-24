---
name: invitation-domain
description: 誘い（DirectInvite）と募集（Broadcast）の用語・状態遷移・不変条件。invitation/availability配下のコード、誘い関連のAPIやUIを変更するときに読む
---
# 誘いのドメイン

## 用語（画面の言葉 → コードの名前）
| 画面 | コード | 意味 |
| --- | --- | --- |
| ここ暇 | Availability | 「誘っていい」という許可。保存は常に時刻の範囲 |
| 時間帯プリセット | Preset | 昼・夕方・夜。入力のショートカットで、境界はユーザーごと |
| くり返し | RecurrenceRule | 毎週の基本暇。ルール＋例外の2層 |
| 誘い（個別） | DirectInvite | 枠と重なれば kind=asobo（あそぼ）、重ならなければ kind=kokodou（ここどう？） |
| 募集 | Broadcast | 複数人への「暇な人いる？」 |
| 行く／今回は難しい／この時間なら | Accept / Decline / CounterProposal | 返答は3種のみ |
| 決める／見送る（この時間なら） | Decide（accept）/ Skip | 「この時間なら」への送信者の決定（docs/specs/T-04-direct-invite.md） |
| 決める | Decide | 募集の締め |
| 応じる／応じるのをやめる | Respond / Withdraw | 募集の宛先の人の操作。断る操作はない |
| 締め切りました | （画面の状態 closed） | 宛先の人に、決まったか期限切れかを区別させずに出す |
| 成立 | Meetup | 会うことが決まった予定 |
| やっぱり難しい | MeetupCancel ／ MeetupLeave | 成立後の定型キャンセル。募集の予定では押した人だけが抜ける（MeetupLeave） |
| お知らせ | Notification | アプリの中で読む通知の1件（notification コンテキスト。docs/specs/T-07-notification.md）。プッシュとメールは「お知らせがある」ことだけを伝える |
| リンクのプレビュー | LinkPreview | 誘い・募集・行きたいに添えたリンクの OGP のカード（link-preview コンテキスト。docs/specs/T-08-link-preview.md）。取れるまでと取れなかったときはドメインだけ |
| 見せる／見せない | SharingPolicy | 自分のここ暇を友達ごとに見せるか（初期値：見せる） |
| 行きたい | Wish | 行きたい店やしたいことを、日時を決めずに置いておくもの（wish コンテキスト。docs/specs/T-22-wishlist.md）。状態の遷移はない |
| 見せない相手（行きたいの） | WishExclusion | その行きたいを見せない友達。行きたいごとに選ぶ。SharingPolicy とは別 |
| 問い合わせ | ContactMessage | 設定から運営に送る問い合わせ（contact コンテキスト。docs/specs/T-24-contact.md）。Slack の非公開のチャンネルに届く |
| 受付番号 | receiptId | 問い合わせの outbox の id。T-13 の問い合わせ番号（requestId）とは別 |
| ブロック | Block | 相手を切る。友達の解除と同じことをし、ブロックの間はどちらの向きの招待リンクでも友達にならない（social。docs/specs/T-33-block-report.md）。相手には知らせない |
| 通報 | Report | 運営に知らせる（contact。outbox の型は UserReported）。問い合わせと同じ Slack に届く。相手には知らせない |
| 「…」のシート | PersonActions | 相手への操作（見せる／見せない → 友達を解除 → ブロック → 通報）。友達の詳細・届いた誘い・届いた募集から開く |
| 退会したユーザー | （プロフィールの withdrawn） | 履歴の相手が退会した人。「名前未設定の友達」と区別し、「さん」を付けない（docs/specs/T-16-withdrawal.md） |

## DirectInvite の状態
pending →（Accept）confirmed → cancelled（やっぱり難しい）
pending →（CounterProposal）counter_proposed →（送信者が決める）confirmed ／（見送る）skipped ／（決めないまま代わりの時間の開始）expired
pending →（Decline、またはここ暇の自動取り消し）declined
pending →（期限）expired
pending（退会した人が送信者）→（退会による打ち切り：期限を今にする。通知なし）expired
counter_proposed →（代わりの時間の開始前に、送信者が退会）skipped（通知なし。受信者が退会したものは触らず、期限で expired）

- `expired` は保存せず、読むときに決める（期限と代わりの時間の開始で判定する）

不変条件：
- 送れるのは友達だけ。自分には送れない
- 期限後は返答できない
- 断りの理由は保存しない・送らない
- 1日の送信は誘い・募集あわせて20件まで

## Broadcast の状態
open →（Decide、応答者1人以上・募集者のみ）decided
open →（期限）expired（保存しない。誰にも通知しない。再募集できる）
open →（募集者が退会：退会による打ち切りで期限を今にする。通知なし）expired

閲覧者ごとの状態（docs/specs/T-05-broadcast.md「状態」）：
- 募集者：open ／ expired ／ decided
- 予定の参加者（決めた時点で応じていた人）：decided
- 参加者でない宛先の人：期限前は open（決めた後も）、期限後は closed（決まった募集も期限切れの募集も同じ）

不変条件：
- IMPORTANT: decided になるまで、応答者の名前を誰にも返さない（募集者本人にも）。返すのは人数だけ
- IMPORTANT: 参加者でない宛先の人には、決まったかどうか・応じた人がいるかを伝えない（応答の形・値・エラーをそろえる）
- 宛先は2〜100人（1人だと人数で応じたかがわかる）
- 募集の予定の「やっぱり難しい」は押した人だけが抜ける（MeetupLeft）。募集者が抜けるか残り1人以下で予定ごと取り消す（MeetupCancelled）
- 決める前に応じた人が退会しても、応じた人数は変えない。「決める」で退会した人を参加者から外す（応じたのが退会した人だけなら409。T-16）
- 予定の参加者は決定後に応答を変えられない。期限後は誰も応答できない（参加者でない宛先の人は、期限までは決定後も応じられる。決定事項6）

## ドメインイベント
| イベント | 受け取る側 |
| --- | --- |
| DirectInviteSent | 受信者に通知（T-07） |
| DirectInviteDeclined・DirectInviteCounterProposed | 送信者に通知（T-07） |
| DirectInviteSkipped | 受信者に通知（T-07） |
| AvailabilityCancelledByCalendar | 取り消しの前に作られた pending の誘いのうち、送信者が受信者のここ暇を取り消しの時点からずっと見られたものだけを、手で断ったときと同じ遷移で declined にする（T-06 決定事項15。判定は availability の `viewersWhoCanSee`）。本人に通知（T-07） |
| MeetupConfirmed | カレンダーへ書き込み（T-06）。直接の誘いの成立は、成立させた人でない方に通知（T-07。募集の成立は BroadcastDecided で通知する） |
| BroadcastSent | 宛先ごとに通知（T-07） |
| LinkAttached | リンク付きの誘い・募集・行きたい（T-22）を作ったときに、作成と同じ batch で書く。link-preview がページを取得して保存する（T-08。payload は ID だけ。送信が拒否されたら書かない） |
| BroadcastDecided | Meetup作成、募集者を除く参加者に名前を開示して通知（T-07。同時に MeetupConfirmed も書く） |
| （期限切れ） | 保存せず読むときに決める。通知しないのでイベントは作らない |
| MeetupLeft | 募集の予定から1人が抜けた。抜けた人のカレンダーから消し、残りの人のタイトルを直す（T-06）。残った参加者に通知（T-07） |
| MeetupCancelled | カレンダーから削除（T-06）、押した人を除く参加者に定型文で通知（T-07） |
| UserWithdrew | 退会の後始末（T-16）。これからの予定は本人の「やっぱり難しい」、受けた pending は「今回は難しい」、送った pending と open の募集は退会による打ち切り、送った counter_proposed は skipped、書いた内容を消す。相手への知らせは MeetupCancelled・MeetupLeft・DirectInviteDeclined で行う |
| ContactMessageSubmitted | 問い合わせを受け付けた。Slack の問い合わせのチャンネルに届ける（T-24。Queue のメッセージは受付番号だけ） |
| UserReported | 通報を受け付けた。同じ Slack のチャンネルに届ける（T-33。Queue のメッセージは受付番号だけ。通報された人には何も送らない） |
