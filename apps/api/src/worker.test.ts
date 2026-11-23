import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "./env";
import { API_CSP, COMMON_HEADERS, IMMUTABLE_ASSET_CACHE, PAGE_CSP } from "./http/securityHeaders";
import { createWorker, routeRequest } from "./worker";

// 振り分けとセキュリティのヘッダー（docs/specs/T-12-release.md「振り分け」「セキュリティのヘッダー」）

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

/** API のアプリの偽物。届いたパスを記録し、経路ごとに決めた応答を返す */
function fakeApp() {
  const seen: string[] = [];
  const app = new Hono<AppEnv>();
  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));
  app.get("/api/v1/own-headers", (c) => {
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    c.header("Cache-Control", "public, max-age=86400, immutable");
    c.header("Referrer-Policy", "same-origin");
    return c.body("x");
  });
  app.get("/api/v1/redirect", (c) => c.redirect("/login", 303));
  app.all("*", (c) => c.json({ code: "not_found" }, 404));
  return {
    seen,
    fetch: (req: Request, e: Bindings, x: ExecutionContext) => {
      seen.push(new URL(req.url).pathname);
      return app.fetch(req, e, x);
    },
  };
}

/** 静的アセットの偽物。ヘッダーを変えられない応答（Response.redirect）や、弱いヘッダー付きの応答を返す */
function fakeAssets() {
  const seen: { method: string; path: string }[] = [];
  const assets = {
    fetch: async (input: RequestInfo) => {
      const req = new Request(input);
      const path = new URL(req.url).pathname;
      seen.push({ method: req.method, path });
      if (path === "/moved") return Response.redirect("https://kokohima.app/", 307);
      if (path === "/icon.svg") return new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } });
      // 静的アセットの既定（再検証させる値）。Worker が immutable に上書きする
      if (path === "/assets/app.js" && req.headers.get("If-None-Match")) return new Response(null, { status: 304, headers: { ETag: '"b"' } });
      if (path === "/assets/app.js")
        return new Response("1", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=0, must-revalidate" } });
      if (path === "/assets/style.css")
        return new Response("a{}", { headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=0, must-revalidate" } });
      if (path === "/assets/moved.js") return Response.redirect("https://kokohima.app/", 307);
      if (path === "/sw.js")
        return new Response("self", { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" } });
      if (req.headers.get("If-None-Match")) return new Response(null, { status: 304, headers: { ETag: '"a"' } });
      // SPA：見つからない経路も index.html
      return new Response("<!doctype html><div id=root></div>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=600",
          "Content-Security-Policy": "default-src *",
          "X-Frame-Options": "ALLOWALL",
        },
      });
    },
  };
  return { seen, assets: assets as unknown as Fetcher };
}

function setup(withAssets = true) {
  const app = fakeApp();
  const a = fakeAssets();
  const bindings = { ...env, ...(withAssets ? { ASSETS: a.assets } : { ASSETS: undefined }) } as Bindings;
  const call = (path: string, init: RequestInit = {}) =>
    routeRequest(app, new Request(`https://kokohima.app${path}`, init), bindings, ctx);
  return { app, assets: a, call };
}

const expectCommon = (res: Response) => {
  for (const [k, v] of Object.entries(COMMON_HEADERS)) expect(res.headers.get(k), k).toBe(v);
};

describe("振り分け", () => {
  it("/api/ は API のアプリ、それ以外の GET・HEAD は静的アセット", async () => {
    const { app, assets, call } = setup();
    expect((await call("/api/v1/health")).status).toBe(200);
    expect(app.seen).toEqual(["/api/v1/health"]);
    for (const path of ["/", "/invites/abc", "/login"]) {
      const res = await call(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<div id=root>");
    }
    const head = await call("/invites/abc", { method: "HEAD" });
    expect(head.status).toBe(200);
    expectCommon(head);
    expect(head.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    expect(assets.seen.map((s) => s.method)).toContain("HEAD");
    expect(app.seen).toEqual(["/api/v1/health"]);
  });

  it("/api（末尾のスラッシュなし）・/apix・//api/・/%61pi/・/API/ は画面の側に回る", async () => {
    const { app, assets, call } = setup();
    for (const path of ["/api", "/apix", "//api/v1/me", "/%61pi/v1/me", "/API/v1/me"]) {
      const res = await call(path);
      expect(res.headers.get("Content-Security-Policy"), path).toBe(PAGE_CSP);
    }
    expect(app.seen).toEqual([]);
    expect(assets.seen).toHaveLength(5);
  });

  it("画面の側の GET・HEAD 以外は405と Allow（/__e2e__ も）", async () => {
    const { app, assets, call } = setup();
    for (const [method, path] of [
      ["POST", "/"],
      ["OPTIONS", "/"],
      ["PUT", "/invites/x"],
      ["DELETE", "/login"],
      ["POST", "/__e2e__/login"],
    ] as const) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
      expectCommon(res);
      expect(res.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    }
    expect(app.seen).toEqual([]);
    expect(assets.seen).toEqual([]);
  });

  it("/api/ の下で API が404を返しても、画面の index.html に置き換えない", async () => {
    const { call } = setup();
    const res = await call("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found" });
    expect(res.headers.get("Content-Security-Policy")).toBe(API_CSP);
  });

  it("ASSETS がない環境（ローカル・E2E）では、どのパスも API のアプリが受ける", async () => {
    const { app, call } = setup(false);
    expect((await call("/login")).status).toBe(404);
    expect((await call("/__e2e__/login", { method: "POST" })).status).toBe(404);
    expect(app.seen).toEqual(["/login", "/__e2e__/login"]);
  });
});

describe("セキュリティのヘッダー", () => {
  it("画面の応答（HTML）：共通のヘッダーと画面用の CSP で、静的アセットの弱い値を上書きし、no-cache", async () => {
    const { call } = setup();
    const res = await call("/invites/abc");
    expectCommon(res);
    expect(res.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).not.toContain("unsafe-inline");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });

  it("SVG・304・ヘッダーを変えられない応答にも、画面用の CSP と共通のヘッダー", async () => {
    const { call } = setup();
    const svg = await call("/icon.svg");
    expect(svg.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    expectCommon(svg);
    const notModified = await call("/invites/abc", { headers: { "If-None-Match": '"a"' } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    // Content-Type のない304でも、SPA の経路は HTML とみなして no-cache
    expect(notModified.headers.get("Cache-Control")).toBe("no-cache");
    const moved = await call("/moved");
    expect(moved.status).toBe(307);
    expect(moved.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    expectCommon(moved);
  });

  it("Cache-Control は /sw.js と HTML だけ no-cache。ほかの画面のファイル・405・リダイレクトは触らない", async () => {
    const { call } = setup();
    expect((await call("/", { method: "POST" })).headers.get("Cache-Control")).toBeNull();
    expect((await call("/moved")).headers.get("Cache-Control")).toBeNull();
    expect((await call("/sw.js")).headers.get("Cache-Control")).toBe("no-cache");
  });

  it("/assets/ の下の200・304は1年の immutable。HTML（見つからない資産の SPA の入口）・405・リダイレクト・ほかのパスは除く", async () => {
    const { call } = setup();
    expect((await call("/assets/app.js")).headers.get("Cache-Control")).toBe(IMMUTABLE_ASSET_CACHE);
    expect(IMMUTABLE_ASSET_CACHE).toBe("public, max-age=31536000, immutable");
    expect((await call("/assets/style.css")).headers.get("Cache-Control")).toBe(IMMUTABLE_ASSET_CACHE);
    const notModified = await call("/assets/app.js", { headers: { "If-None-Match": '"b"' } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("Cache-Control")).toBe(IMMUTABLE_ASSET_CACHE);
    // 見つからない資産は SPA の index.html が返る。HTML なので no-cache のまま（長く持たせない）
    expect((await call("/assets/missing-abc.js")).headers.get("Cache-Control")).toBe("no-cache");
    expect((await call("/assets/app.js", { method: "POST" })).headers.get("Cache-Control")).toBeNull();
    expect((await call("/assets/moved.js")).headers.get("Cache-Control")).toBeNull();
    // 先頭が /assets/ でないもの（ハッシュの付かない public のファイル）は既定のまま
    expect((await call("/icon.svg")).headers.get("Cache-Control")).toBeNull();
    expect((await call("/%61ssets/app.js")).headers.get("Cache-Control")).toBe("no-cache");
  });

  it("API の応答：共通のヘッダーと default-src 'none' の CSP。経路が付けたヘッダーは上書きしない", async () => {
    const { call } = setup();
    const health = await call("/api/v1/health");
    expectCommon(health);
    expect(health.headers.get("Content-Security-Policy")).toBe(API_CSP);
    const own = await call("/api/v1/own-headers");
    expect(own.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(own.headers.get("Cache-Control")).toBe("public, max-age=86400, immutable");
    expect(own.headers.get("Referrer-Policy")).toBe("same-origin");
    const redirect = await call("/api/v1/redirect");
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("Location")).toBe("/login");
    expectCommon(redirect);
  });

  it("本番の Worker（createWorker）の fetch：API の応答にヘッダーが付く", async () => {
    const { handler } = createWorker();
    const res = await handler.fetch(new Request("https://kokohima.app/api/v1/health"), { ...env } as Bindings, ctx);
    expect(res.status).toBe(200);
    expectCommon(res);
    expect(res.headers.get("Content-Security-Policy")).toBe(API_CSP);
  });
});
