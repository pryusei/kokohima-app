import { RETENTION } from "@kokohima/shared";
import { describe, expect, it } from "vitest";
import { MAX_LENGTH_MS } from "../availability/domain/validation";
import { FREE_BUSY_CACHE_SECONDS } from "../calendar/application/freeSlots";
import { DORMANT_AFTER_MS } from "../calendar/application/dormancy";
import { DEAD_SESSION_RETENTION_MS } from "../identity/infra/repository";
import { IMAGE_GRACE_MS, PREVIEW_RETENTION_MS } from "../link-preview/application/previews";
import { countsCutoffDay, NOTIFICATION_RETENTION_MS } from "../notification/application/delivery";
import { IDEMPOTENCY_TTL_MS } from "../shared/idempotency";
import { WISH_POSTS_RETENTION_MS } from "../wish/application/wishes";
import { AVAILABILITY_RETENTION_MS, exceptionCutoffDate, OUTBOX_RETENTION_MS, RETENTION_MS } from "./dispatch";

// API の掃除の定数が、packages/shared の RETENTION（プライバシー ポリシーの「8.」と同じ数）から作られ、
// 今までの値のままであること（docs/specs/T-19-privacy-terms.md「9.」）
const DAY = 24 * 60 * 60 * 1000;

describe("保存期間の定数（T-19「9.」）", () => {
  it("誘い・募集・招待リンク・流れないままの通知の記録は同じ30日の境目を使う", () => {
    expect(RETENTION_MS).toBe(30 * DAY);
    expect(RETENTION_MS).toBe(RETENTION.invitationsDays * DAY);
    expect(RETENTION.inviteLinksDays).toBe(RETENTION.invitationsDays);
    expect(RETENTION.staleNotificationOutboxDays).toBe(RETENTION.invitationsDays);
  });

  it("お知らせ・ログインの記録・休眠・リンクのプレビューは30日", () => {
    expect(NOTIFICATION_RETENTION_MS).toBe(30 * DAY);
    expect(NOTIFICATION_RETENTION_MS).toBe(RETENTION.notificationsDays * DAY);
    expect(DEAD_SESSION_RETENTION_MS).toBe(RETENTION.deadSessionsDays * DAY);
    expect(DORMANT_AFTER_MS).toBe(RETENTION.dormantAfterDays * DAY);
    expect(PREVIEW_RETENTION_MS).toBe(RETENTION.linkPreviewsDays * DAY);
  });

  it("処理済みの outbox は7日", () => {
    expect(OUTBOX_RETENTION_MS).toBe(7 * DAY);
    expect(OUTBOX_RETENTION_MS).toBe(RETENTION.processedOutboxDays * DAY);
  });

  it("ここ暇の枠：枠の長さの上限は RETENTION と同じで、掃除は始まりから「長さの上限＋終わってから1日」", () => {
    expect(MAX_LENGTH_MS).toBe(RETENTION.availabilityMaxLengthDays * DAY);
    expect(AVAILABILITY_RETENTION_MS).toBe((RETENTION.availabilityGraceDays + RETENTION.availabilityMaxLengthDays) * DAY);
    expect(AVAILABILITY_RETENTION_MS).toBe(2 * DAY);
  });

  it("お知らせの日ごとの数は UTC の今日の3日前の日付より前、リンクのプレビューの画像は参照がなくなって1時間", () => {
    expect(RETENTION.notificationDailyCountsDaysBefore).toBe(3);
    expect(countsCutoffDay(Date.parse("2026-11-23T10:00:00Z"))).toBe("2026-11-20");
    expect(IMAGE_GRACE_MS).toBe(RETENTION.linkPreviewImageGraceHours * 60 * 60 * 1000);
    expect(IMAGE_GRACE_MS).toBe(60 * 60 * 1000);
  });

  it("行きたいを置いた記録は2日（T-22）", () => {
    expect(WISH_POSTS_RETENTION_MS).toBe(RETENTION.wishPostsDays * DAY);
    expect(WISH_POSTS_RETENTION_MS).toBe(2 * DAY);
  });

  it("くり返しの例外は UTC の今日の2日前の日付より前", () => {
    expect(exceptionCutoffDate(Date.parse("2026-11-23T10:00:00Z"))).toBe("2026-11-21");
  });

  it("冪等キーは24時間、埋まりのキャッシュは5分", () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(RETENTION.idempotencyKeysHours * 60 * 60 * 1000);
    expect(IDEMPOTENCY_TTL_MS).toBe(DAY);
    expect(FREE_BUSY_CACHE_SECONDS).toBe(RETENTION.freeBusyCacheMinutes * 60);
    expect(FREE_BUSY_CACHE_SECONDS).toBe(300);
  });
});
