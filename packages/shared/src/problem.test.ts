import { describe, expect, it } from "vitest";
import { problemSchema } from "./problem";

describe("problemSchema", () => {
  it("api-conventions の形のエラーを受け付ける", () => {
    const result = problemSchema.safeParse({
      type: "about:blank",
      title: "Validation failed",
      status: 400,
      code: "validation_failed",
      requestId: "req-1",
      errors: [{ path: "message", code: "too_long" }],
    });
    expect(result.success).toBe(true);
  });

  it("定義されていない code は拒否する", () => {
    const result = problemSchema.safeParse({
      type: "about:blank",
      title: "Teapot",
      status: 418,
      code: "teapot",
      requestId: "req-1",
    });
    expect(result.success).toBe(false);
  });
});
