import { Hono } from "hono";
import * as z from "zod";
import type { AppEnv } from "../env";
import { problem } from "../http/problem";
import { rateLimit } from "../http/rateLimit";
import { avatarImageFor, removeAvatar, uploadAvatar } from "./application/avatar";
import * as auth from "./application/auth";
import { AVATAR_MAX_BYTES } from "./domain/avatarJpeg";
import { requireActiveSession, requireAuth, requireSameOrigin } from "./middleware";

// アイコンの画像（docs/specs/T-27-avatar-upload.md「API」）

const avatarId = z.uuid();

/** 本文を上限まで読む。超えたらそこで止めて null */
async function readBody(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function avatarRoutes() {
  const app = new Hono<AppEnv>();
  const ctx = (c: { env: AppEnv["Bindings"]; var: { deps: AppEnv["Variables"]["deps"] } }) => ({ env: c.env, deps: c.var.deps });
  const invalid = (requestId: string, code: string) =>
    problem(requestId, 400, "validation_failed", "Validation failed", [{ path: "(body)", code }]);

  // 置き換える（同じ画像を二度送っても最後の画像が残るだけなので、冪等キーは受けない）
  app.put(
    "/me/avatar",
    requireAuth,
    requireActiveSession,
    requireSameOrigin,
    rateLimit({ group: "avatar_upload", limiter: "RL_USER", by: "user" }),
    async (c) => {
      const requestId = c.get("requestId");
      const type = (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "image/jpeg") return invalid(requestId, "unsupported_type");
      const body = await readBody(c.req.raw, AVATAR_MAX_BYTES);
      if (!body) return invalid(requestId, "too_large");
      const result = await uploadAvatar(ctx(c), c.var.viewer.userId, body);
      if (result.kind === "invalid") return invalid(requestId, result.error);
      const me = result.kind === "ok" ? await auth.getMe(ctx(c), c.var.viewer.userId) : null;
      if (!me) return problem(requestId, 404, "not_found", "Not Found");
      return c.json(me);
    },
  );

  app.delete("/me/avatar", requireAuth, requireActiveSession, requireSameOrigin, async (c) => {
    await removeAvatar(ctx(c), c.var.viewer.userId);
    return c.body(null, 204);
  });

  // 配信。認証なし（<img> で読む）。署名と期限を確かめる。回数の上限は付けない（T-27 決めたこと6）
  app.get("/avatars/:avatarId", async (c) => {
    const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    const id = avatarId.safeParse(c.req.param("avatarId"));
    if (!id.success) return notFound();
    const body = await avatarImageFor(ctx(c), id.data.toLowerCase(), c.req.query("e"), c.req.query("s"));
    if (!body) return notFound();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, max-age=3600",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Disposition": "inline",
        "Referrer-Policy": "no-referrer",
      },
    });
  });

  return app;
}
