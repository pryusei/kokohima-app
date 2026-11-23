import { describe, expect, it } from "vitest";
import { createWishSuggestionRequestSchema, wishSuggestionCandidateSchema } from "./wishSuggestion";

// 行きたいのAI提案の入力（docs/specs/T-29-wish-suggestion.md「入力」）

describe("createWishSuggestionRequestSchema", () => {
  it("エリアと言葉を前後の空白を除いて受け取る", () => {
    expect(createWishSuggestionRequestSchema.parse({ area: " 渋谷 ", query: "ラーメン、夜遅く" })).toEqual({
      area: "渋谷",
      query: "ラーメン、夜遅く",
    });
  });

  it.each([
    [{ area: "", query: "ラーメン" }, "area"],
    [{ area: "渋谷", query: "   " }, "query"],
    [{ area: "渋谷", query: "あ".repeat(61) }, "query"],
    [{ area: "渋谷", query: "ラーメン\nつけ麺" }, "query"],
    [{ area: "渋谷", query: "ラー​メン" }, "query"],
    [{ area: "あ".repeat(31), query: "ラーメン" }, "area"],
  ])("空・長すぎ・改行・見えない文字は通さない（%#）", (body, field) => {
    const r = createWishSuggestionRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([field]);
  });

  it("60文字ちょうどは通る。知らない項目は通さない", () => {
    expect(createWishSuggestionRequestSchema.safeParse({ area: "渋谷", query: "あ".repeat(60) }).success).toBe(true);
    expect(createWishSuggestionRequestSchema.safeParse({ area: "渋谷", query: "x", extra: 1 }).success).toBe(false);
  });
});

describe("wishSuggestionCandidateSchema", () => {
  const ok = { message: "こもれびのつけ麺行きたい", placeName: "麺処こもれび", url: "https://example.test/a", reason: "夜2時まで" };

  it("形が合えば通る", () => {
    expect(wishSuggestionCandidateSchema.safeParse(ok).success).toBe(true);
  });

  it.each([
    { ...ok, url: "javascript:alert(1)" },
    { ...ok, url: null },
    { ...ok, reason: "あ".repeat(41) },
    { ...ok, reason: "一行め\n二行め" },
    { ...ok, placeName: "あ".repeat(41) },
    { ...ok, message: "" },
  ])("URL の形・文字数・改行・空は通さない（%#）", (c) => {
    expect(wishSuggestionCandidateSchema.safeParse(c).success).toBe(false);
  });
});
