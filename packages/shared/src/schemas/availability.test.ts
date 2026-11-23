import { describe, expect, it } from "vitest";
import { rangeQuerySchema } from "./availability";

describe("rangeQuerySchema", () => {
  it("from < to の範囲を受け付ける", () => {
    expect(rangeQuerySchema.safeParse({ from: "2026-10-10T00:00:00Z", to: "2026-10-24T00:00:00Z" }).success).toBe(true);
  });

  it("下限・上限ちょうどは受け付ける", () => {
    expect(rangeQuerySchema.safeParse({ from: "1970-01-01T00:00:00Z", to: "1970-01-15T00:00:00Z" }).success).toBe(true);
    expect(rangeQuerySchema.safeParse({ from: "9998-12-01T00:00:00Z", to: "9999-01-01T00:00:00Z" }).success).toBe(true);
  });

  it("下限より前・上限より後の日時は不正（現地の日付と前後1日が4桁の年に収まるように）", () => {
    for (const q of [
      { from: "9999-12-25T00:00:00Z", to: "9999-12-31T23:00:00Z" },
      { from: "9998-12-31T00:00:00Z", to: "9999-01-01T00:15:00Z" },
      { from: "0000-01-01T00:00:00Z", to: "0000-01-08T00:00:00Z" },
      { from: "1969-12-31T23:45:00Z", to: "1970-01-02T00:00:00Z" },
    ]) {
      expect(rangeQuerySchema.safeParse(q).success).toBe(false);
    }
  });
});
