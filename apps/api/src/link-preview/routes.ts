import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { rateLimit } from "../http/rateLimit";
import { imageFor } from "./application/previews";

// リンクのプレビューの画像の配信（docs/specs/T-08-link-preview.md「API」「配信」）。認証なし（<img> で読む）。
// 推測できない UUID で、status が ok の行の画像だけを返す

const imageId = z.uuid();

export function linkPreviewRoutes() {
  const app = new Hono<AppEnv>();
  app.get(
    "/link-previews/images/:imageId",
    rateLimit({
      group: "link_image",
      limiter: "RL_PUBLIC",
      by: "ip",
      onLimited: () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
    }),
    async (c) => {
      const notFound = () => problem(c.get("requestId"), 404, "not_found", "Not Found");
      const id = imageId.safeParse(c.req.param("imageId"));
      if (!id.success) return notFound();
      const image = await imageFor({ env: c.env, deps: c.var.deps }, id.data.toLowerCase());
      if (!image) return notFound();
      return new Response(image.body, {
        status: 200,
        headers: {
          "Content-Type": image.type,
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cache-Control": "public, max-age=86400, immutable",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Disposition": "inline",
        },
      });
    },
  );
  return app;
}
