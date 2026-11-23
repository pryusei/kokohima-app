import { describe, expect, it } from "vitest";
import { PLATFORM_RETENTION, RETENTION, RETENTION_UNIT_MS } from "./retention";

// 値は docs/specs/T-17-retention.md「1. 保持期間の一覧」と同じ。変えるときは、この表と T-17 の表、/privacy の「8.」を同じPRで直す
describe("保存期間の数（T-19「9.」）", () => {
  it("T-17 の表と同じ値", () => {
    expect(RETENTION).toEqual({
      invitationsDays: 30,
      notificationsDays: 30,
      inviteLinksDays: 30,
      deadSessionsDays: 30,
      dormantAfterDays: 30,
      availabilityGraceDays: 1,
      availabilityMaxLengthDays: 1,
      recurrenceExceptionDaysBefore: 2,
      notificationDailyCountsDaysBefore: 3,
      processedOutboxDays: 7,
      staleNotificationOutboxDays: 30,
      linkPreviewsDays: 30,
      linkPreviewImageGraceHours: 1,
      wishPostsDays: 2,
      idempotencyKeysHours: 24,
      freeBusyCacheMinutes: 5,
    });
  });

  it("プラットフォームの値（表示にだけ使う）", () => {
    expect(PLATFORM_RETENTION).toEqual({ workersLogsDays: 7, deadLetterQueueDays: 4, databaseRestoreDays: 30 });
  });

  it("単位", () => {
    expect(RETENTION_UNIT_MS).toEqual({ minute: 60_000, hour: 3_600_000, day: 86_400_000 });
  });
});
