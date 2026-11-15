import type { NotificationDto } from "@kokohima/shared";

// お知らせの文言と行き先（仮。docs/specs/T-07-notification.md「お知らせ一覧」）
// 断り・見送り・キャンセルは、理由を書かずに静かに出す

const nameOf = (n: NotificationDto) => n.actor?.displayName ?? "名前未設定の友達";

export function textOf(n: NotificationDto): string {
  switch (n.kind) {
    case "invite_received":
      return `${nameOf(n)}さんから誘いが届きました`;
    case "invite_declined":
      return `${nameOf(n)}さんは今回は難しいみたい`;
    case "invite_countered":
      return `${nameOf(n)}さんから別の時間の提案があります`;
    case "invite_skipped":
      return "今回は見送りになりました";
    case "broadcast_received":
      return `${nameOf(n)}さんが募集しています`;
    case "broadcast_decided":
      return `${nameOf(n)}さんの募集が決まりました`;
    case "meetup_confirmed":
      return `${nameOf(n)}さんと予定が成立しました`;
    case "meetup_cancelled":
      return "予定がなくなりました";
    case "meetup_left":
      return "予定から1人抜けました";
    case "friend_added":
      return `${nameOf(n)}さんと友達になりました`;
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
      return "/friends";
  }
}
