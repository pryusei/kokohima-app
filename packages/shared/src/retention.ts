// 保存期間の数（docs/specs/T-19-privacy-terms.md「9.」、docs/specs/T-17-retention.md「1. 保持期間の一覧」）。
// API の掃除と、プライバシー ポリシーのページ（/privacy の「8.」）の両方がここから読む。
// 値を変えるときは、T-17 の表と、この数を確かめるテスト（retention.test.ts）を同じPRで直す

export const RETENTION = {
  /** 誘い・募集・成立した予定：予定の時間の終わり（代わりの時間があれば遅い方）から */
  invitationsDays: 30,
  /** お知らせ：作ってから */
  notificationsDays: 30,
  /** 招待リンク：期限から */
  inviteLinksDays: 30,
  /** ログインの記録（セッション・更新用トークン）：失効・期限切れから */
  deadSessionsDays: 30,
  /** カレンダーの連携の休眠：最後に使ってから */
  dormantAfterDays: 30,
  /**
   * ここ暇の手動の枠：始まりから「長さの上限（availabilityMaxLengthDays）＋この日数」で消す。
   * 終わりから数えるのではない（枠は最長1日なので、終わってから1〜2日で消える）
   */
  availabilityGraceDays: 1,
  /** ここ暇の枠の長さの上限（入力の検証のルール。apps/api の availability/domain/validation.ts の MAX_LENGTH_MS と同じ） */
  availabilityMaxLengthDays: 1,
  /** くり返しの例外：日付が UTC の今日のこの日数前より前なら消す（日付から3日目に消える） */
  recurrenceExceptionDaysBefore: 2,
  /** お知らせの日ごとの数：日付が UTC の今日のこの日数前より前なら消す */
  notificationDailyCountsDaysBefore: 3,
  /** 処理済みの outbox：処理してから */
  processedOutboxDays: 7,
  /** 流れないままの通知だけの型の outbox：作ってから */
  staleNotificationOutboxDays: 30,
  /** リンクのプレビューの結果：参照がなく、取得から */
  linkPreviewsDays: 30,
  /** リンクのプレビューの画像（R2・台帳）：参照する結果がなくなり、置いてから */
  linkPreviewImageGraceHours: 1,
  /** 行きたいを置いた回数の記録（置く回数の上限を数える。中身は持たない）：作ってから。行きたい自体は本人が消すまで・退会まで（T-22） */
  wishPostsDays: 2,
  /** 冪等キー */
  idempotencyKeysHours: 24,
  /** カレンダーの埋まりのキャッシュ（KV） */
  freeBusyCacheMinutes: 5,
} as const;

/**
 * コードが期間を持たない、プラットフォームの値（Cloudflare の設定・既定値）。表示にだけ使う。
 * 変わってもコードでは気づけないので、T-17 の表を直す PR のチェックリストで確かめる
 */
export const PLATFORM_RETENTION = {
  /** Workers Logs（有料プラン。T-13） */
  workersLogsDays: 7,
  /** 退避キュー（Queues の既定。T-13 の手順書） */
  deadLetterQueueDays: 4,
  /** D1 の復元（Time Travel。#89） */
  databaseRestoreDays: 30,
} as const;

/** 保存期間の数をミリ秒にする単位 */
export const RETENTION_UNIT_MS = { minute: 60 * 1000, hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 } as const;
