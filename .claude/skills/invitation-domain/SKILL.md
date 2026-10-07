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
| 決める | Decide | 募集の締め |
| 成立 | Meetup | 会うことが決まった予定 |
| やっぱり難しい | MeetupCancel | 成立後の定型キャンセル |
| 見せる／見せない | SharingPolicy | 自分のここ暇を友達ごとに見せるか（初期値：見せる） |

## DirectInvite の状態
pending →（Accept）confirmed → cancelled（やっぱり難しい）
pending →（CounterProposal）countered →（送信者が決める）confirmed ／（見送る）skipped
pending →（Decline、またはここ暇の自動取り消し）declined
pending →（期限）expired

不変条件：
- 送れるのは友達だけ。自分には送れない
- 期限後は返答できない
- 断りの理由は保存しない・送らない
- 1日の送信は誘い・募集あわせて20件まで

## Broadcast の状態
open →（Decide、応答者1人以上・募集者のみ）decided
open →（期限）expired（誰にも通知しない。再募集できる）

不変条件：
- IMPORTANT: decided になるまで、応答者の名前を誰にも返さない（募集者本人にも）。返すのは人数だけ
- decided・expired の後は応答できない

## ドメインイベント
| イベント | 受け取る側 |
| --- | --- |
| AvailabilityCancelledByCalendar | 未返答の誘いを自動で declined にし、本人に通知 |
| MeetupConfirmed | カレンダーへ書き込み、通知 |
| BroadcastDecided | Meetup作成、参加者全員に名前を開示して通知 |
| BroadcastExpired | 状態更新のみ。通知しない |
| MeetupCancelled | カレンダーから削除、定型文で通知 |
