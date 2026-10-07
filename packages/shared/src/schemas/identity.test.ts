import { describe, expect, it } from "vitest";
import { authCompleteResponseSchema, meResponseSchema } from "./identity";

describe("identity schemas", () => {
  it("完了の応答は accessToken・expiresAt・returnTo を持つ", () => {
    const ok = authCompleteResponseSchema.safeParse({
      accessToken: "x.y.z",
      expiresAt: "2026-10-10T02:00:00Z",
      returnTo: "/",
    });
    expect(ok.success).toBe(true);
  });

  it("me は displayName・avatarUrl が null でもよいが、項目は省けない", () => {
    const id = "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11";
    expect(meResponseSchema.safeParse({ id, displayName: null, avatarUrl: null }).success).toBe(true);
    expect(meResponseSchema.safeParse({ id }).success).toBe(false);
  });
});
