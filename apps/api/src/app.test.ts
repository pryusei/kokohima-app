import { describe, expect, it } from "vitest";
import { problemSchema } from "@kokohima/shared";
import { createApp } from "./app";

describe("api", () => {
  const app = createApp();

  it("GET /api/v1/health は ok を返す", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("存在しないパスは problem+json の not_found を返す", async () => {
    const res = await app.request("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = problemSchema.parse(await res.json());
    expect(body.code).toBe("not_found");
    expect(body.requestId).not.toBe("");
  });

  it("例外の中身をレスポンスに出さない", async () => {
    const failing = createApp();
    failing.get("/boom", () => {
      throw new Error("secret-internal-detail");
    });
    const res = await failing.request("/boom");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret-internal-detail");
    expect(problemSchema.parse(JSON.parse(text)).code).toBe("internal_error");
  });
});
