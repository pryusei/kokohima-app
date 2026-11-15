import type { NotificationDto } from "@kokohima/shared";

// お知らせの文言と行き先（仮。docs/specs/T-07-notification.md「お知らせ一覧」）
// 断り・見送り・キャンセルは、理由を書かずに静かに出す

// 相手の表示名。表示名がなければ「名前未設定の友達」。相手が退会などで読めない（actor が null）ときは、名前のない文言にする
const nameOf = (n: NotificationDto) => n.actor?.displayName ?? "名前未設定の友達";

/** 相手がいる文言は「〇〇さん」をつけ、相手が読めなければ名前のない文言にする */
const withActor = (n: NotificationDto, named: (name: string) => string, nameless: string) =>
  n.actor ? named(nameOf(n)) : nameless;

export function textOf(n: NotificationDto): string {
  switch (n.kind) {
    case "invite_received":
      return withActor(n, (name) => `${name}さんから誘いが届きました`, "誘いが届きました");
    case "invite_declined":
      return withActor(n, (name) => `${name}さんは今回は難しいみたい`, "誘いに返事がありました");
    case "invite_countered":
      return withActor(n, (name) => `${name}さんから別の時間の提案があります`, "別の時間の提案があります");
    case "invite_skipped":
      return "今回は見送りになりました";
    case "broadcast_received":
      return withActor(n, (name) => `${name}さんが募集しています`, "募集が届きました");
    case "broadcast_decided":
      return withActor(n, (name) => `${name}さんの募集が決まりました`, "募集が決まりました");
    case "meetup_confirmed":
      return withActor(n, (name) => `${name}さんと予定が成立しました`, "予定が成立しました");
    case "meetup_cancelled":
      return "予定がなくなりました";
    case "meetup_left":
      return "予定から1人抜けました";
    case "friend_added":
      return withActor(n, (name) => `${name}さんと友達になりました`, "友達が増えました");
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
