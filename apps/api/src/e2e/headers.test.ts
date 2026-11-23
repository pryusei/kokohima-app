import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../env";
import { API_CSP, COMMON_HEADERS } from "../http/securityHeaders";
import e2eHandler from "./entry";

// E2E のエントリ（createWorker を共有）の応答にも、セキュリティのヘッダーが付く（docs/specs/T-12-release.md）

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

describe("E2E のエントリのヘッダー", () => {
  it("API の応答と E2E の経路の応答に、共通のヘッダーと API の CSP", async () => {
    const bindings = { ...env, E2E_MODE: "1" } as Bindings;
    const fetch = e2eHandler.fetch as (req: Request, env: Bindings, ctx: ExecutionContext) => Promise<Response>;
    for (const [method, path] of [
      ["GET", "/api/v1/health"],
      ["POST", "/__e2e__/outbox/drain"],
    ] as const) {
      const res = await fetch(new Request(`https://kokohima.app${path}`, { method }), bindings, ctx);
      for (const [k, v] of Object.entries(COMMON_HEADERS)) expect(res.headers.get(k), `${path} ${k}`).toBe(v);
      expect(res.headers.get("Content-Security-Policy")).toBe(API_CSP);
    }
  });
});
