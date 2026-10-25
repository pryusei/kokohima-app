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
| 見せる／見せない | SharingPolicy | 自分のここ暇を友達ごとに見せるか（初期値：見せる） |

## DirectInvite の状態
pending →（Accept）confirmed → cancelled（やっぱり難しい）
pending →（CounterProposal）counter_proposed →（送信者が決める）confirmed ／（見送る）skipped ／（決めないまま代わりの時間の開始）expired
pending →（Decline、またはここ暇の自動取り消し）declined
pending →（期限）expired

- `expired` は保存せず、読むときに決める（期限と代わりの時間の開始で判定する）

不変条件：
- 送れるのは友達だけ。自分には送れない
- 期限後は返答できない
- 断りの理由は保存しない・送らない
- 1日の送信は誘い・募集あわせて20件まで

## Broadcast の状態
open →（Decide、応答者1人以上・募集者のみ）decided
open →（期限）expired（保存しない。誰にも通知しない。再募集できる）

閲覧者ごとの状態（docs/specs/T-05-broadcast.md「状態」）：
- 募集者：open ／ expired ／ decided
- 予定の参加者（決めた時点で応じていた人）：decided
- 参加者でない宛先の人：期限前は open（決めた後も）、期限後は closed（決まった募集も期限切れの募集も同じ）

不変条件：
- IMPORTANT: decided になるまで、応答者の名前を誰にも返さない（募集者本人にも）。返すのは人数だけ
- IMPORTANT: 参加者でない宛先の人には、決まったかどうか・応じた人がいるかを伝えない（応答の形・値・エラーをそろえる）
- 宛先は2〜100人（1人だと人数で応じたかがわかる）
- 募集の予定の「やっぱり難しい」は押した人だけが抜ける（MeetupLeft）。募集者が抜けるか残り1人以下で予定ごと取り消す（MeetupCancelled）
- 予定の参加者は決定後に応答を変えられない。期限後は誰も応答できない（参加者でない宛先の人は、期限までは決定後も応じられる。決定事項6）

## ドメインイベント
| イベント | 受け取る側 |
| --- | --- |
| DirectInviteSent | 受信者に通知（T-07） |
| DirectInviteDeclined・DirectInviteCounterProposed | 送信者に通知（T-07） |
| DirectInviteSkipped | 受信者に通知（T-07） |
| AvailabilityCancelledByCalendar | 未返答の誘いを自動で declined にし、本人に通知 |
| MeetupConfirmed | カレンダーへ書き込み、通知 |
| BroadcastSent | 宛先ごとに通知（T-07） |
| BroadcastDecided | Meetup作成、参加者全員に名前を開示して通知（同時に MeetupConfirmed も書く） |
| （期限切れ） | 保存せず読むときに決める。通知しないのでイベントは作らない |
| MeetupLeft | 募集の予定から1人が抜けた。残った参加者に通知（T-07） |
| MeetupCancelled | カレンダーから削除、定型文で通知 |
