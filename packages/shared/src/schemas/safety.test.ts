import { describe, expect, it } from "vitest";
import { isSafetyOpen, safetyStartAt } from "../safetyStart";
import safetyStart from "../safetyStart.json";
import {
  createBlockRequestSchema,
  REPORT_DAILY_LIMIT,
  REPORT_DETAILS_MAX,
  REPORT_LIMIT_WINDOW_HOURS,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  reportRequestSchema,
} from "./safety";

// ブロックと通報の入力（docs/specs/T-33-block-report.md「API」「テスト計画」）

const userId = "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11";
const subject = { type: "direct_invite", id: "0b8d1c3e-2f4a-4b6c-9d8e-1a2b3c4d5e6f" } as const;

describe("reportRequestSchema", () => {
  it("理由・くわしく・対象・ブロックもするを受け取り、くわしくは問い合わせと同じく正規化する", () => {
    const r = reportRequestSchema.parse({ userId, reason: "unsafe_meetup", details: " 夜に一人で来てと言われた\r\n ", subject, alsoBlock: true });
    expect(r).toEqual({ userId, reason: "unsafe_meetup", details: "夜に一人で来てと言われた", subject, alsoBlock: true });
  });

  it("くわしく・対象は省ける", () => {
    expect(reportRequestSchema.parse({ userId, reason: "other", alsoBlock: false })).toEqual({ userId, reason: "other", alsoBlock: false });
  });

  it("くわしくは1000文字（コードポイント）まで。空白だけは400", () => {
    expect(reportRequestSchema.safeParse({ userId, reason: "other", details: "あ".repeat(REPORT_DETAILS_MAX), alsoBlock: false }).success).toBe(true);
    expect(reportRequestSchema.safeParse({ userId, reason: "other", details: "あ".repeat(REPORT_DETAILS_MAX + 1), alsoBlock: false }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ userId, reason: "other", details: "   ", alsoBlock: false }).success).toBe(false);
  });

  it("知らない理由・知らない項目（送り主の指定を含む）・ブロックもするがないものは400", () => {
    expect(reportRequestSchema.safeParse({ userId, reason: "spam", alsoBlock: false }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ userId, reason: "other", alsoBlock: false, reporterId: userId }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ userId, reason: "other" }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ userId, reason: "other", alsoBlock: false, subject: { ...subject, message: "x" } }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ userId, reason: "other", alsoBlock: false, subject: { type: "meetup", id: subject.id } }).success).toBe(false);
  });

  it("理由は5つで、どれにも表示の名前がある", () => {
    expect(REPORT_REASONS).toHaveLength(5);
    for (const r of REPORT_REASONS) expect(REPORT_REASON_LABELS[r]).toBeTruthy();
    expect(REPORT_DAILY_LIMIT).toBe(5);
    expect(REPORT_LIMIT_WINDOW_HOURS).toBe(24);
  });
});

describe("createBlockRequestSchema", () => {
  it("相手の ID と、任意の対象だけを受け取る", () => {
    expect(createBlockRequestSchema.parse({ userId })).toEqual({ userId });
    expect(createBlockRequestSchema.parse({ userId, subject })).toEqual({ userId, subject });
    expect(createBlockRequestSchema.safeParse({ userId: "x" }).success).toBe(false);
    expect(createBlockRequestSchema.safeParse({ userId, blockerId: userId }).success).toBe(false);
  });
});

describe("safetyStart", () => {
  it("日本時間の0時から開く。null ならいつも閉じている", () => {
    const at = safetyStartAt("2026-12-08");
    expect(at).toBe(Date.parse("2026-12-07T15:00:00Z"));
    expect(isSafetyOpen(at! - 1, at)).toBe(false);
    expect(isSafetyOpen(at!, at)).toBe(true);
    expect(safetyStartAt(null)).toBeNull();
    expect(isSafetyOpen(Date.now(), null)).toBe(false);
  });

  it("JSON の値は null か暦にある日付", () => {
    const v = (safetyStart as { startDate: string | null }).startDate;
    if (v !== null) expect(Number.isNaN(Date.parse(`${v}T00:00:00+09:00`))).toBe(false);
  });
});
