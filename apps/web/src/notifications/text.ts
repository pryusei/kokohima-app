import type { NotificationDto } from "@kokohima/shared";
import { honorificOf } from "../account/me";

// お知らせの文言と行き先（仮。docs/specs/T-07-notification.md「お知らせ一覧」）
// 断り・見送り・キャンセルは、理由を書かずに静かに出す

/**
 * 相手がいる文言は「〇〇さん」をつけ（表示名がなければ「名前未設定の友達さん」）、相手が読めなければ名前のない文言にする。
 * 退会した相手は「退会したユーザー」（さんを付けない。docs/specs/T-16-withdrawal.md）
 */
const withActor = (n: NotificationDto, named: (name: string) => string, nameless: string) =>
  n.actor ? named(honorificOf(n.actor)) : nameless;

export function textOf(n: NotificationDto): string {
  switch (n.kind) {
    case "invite_received":
      return withActor(n, (name) => `${name}から誘いが届きました`, "誘いが届きました");
    case "invite_declined":
      return withActor(n, (name) => `${name}は今回は難しいみたい`, "誘いに返事がありました");
    case "invite_countered":
      return withActor(n, (name) => `${name}から別の時間の提案があります`, "別の時間の提案があります");
    case "invite_skipped":
      return "今回は見送りになりました";
    case "broadcast_received":
      return withActor(n, (name) => `${name}が募集しています`, "募集が届きました");
    case "broadcast_decided":
      return withActor(n, (name) => `${name}の募集が決まりました`, "募集が決まりました");
    case "meetup_confirmed":
      return withActor(n, (name) => `${name}と予定が成立しました`, "予定が成立しました");
    case "meetup_cancelled":
      return "予定がなくなりました";
    case "meetup_left":
      return "予定から1人抜けました";
    case "friend_added":
      return withActor(n, (name) => `${name}と友達になりました`, "友達が増えました");
    case "availability_cancelled":
      return `カレンダーの予定と重なったここ暇を${n.count ?? 1}件取り消しました`;
    case "calendar_reauth":
      return "カレンダーの連携が切れました";
    case "new_login":
      return n.device ? `新しい端末でログインがありました（${n.device}）` : "新しい端末でログインがありました";
  }
}

export function linkOf(n: NotificationDto): string {
  const id = n.subjectId ? encodeURIComponent(n.subjectId) : null;
  switch (n.kind) {
    case "invite_received":
    case "invite_declined":
    case "invite_countered":
    case "invite_skipped":
      return id ? `/invites/${id}` : "/invites";
    case "broadcast_received":
    case "broadcast_decided":
      return id ? `/broadcasts/${id}` : "/invites";
    case "meetup_confirmed":
    case "meetup_cancelled":
    case "meetup_left":
      return id ? `/meetups/${id}` : "/invites";
    case "friend_added":
      return id ? `/friends/${id}` : "/friends";
    case "availability_cancelled":
      return "/availability";
    case "calendar_reauth":
      return "/settings/calendar";
    case "new_login":
      // 設定のアカウント（ログアウト・全端末ログアウト）。docs/specs/T-11-design.md「画面のつながり」
      return "/settings/account";
  }
}
