import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { validationFailed } from "./validation";

// 本文の上限（UTF-8 のバイト数。docs/specs/T-24-contact.md「API」の4）。Content-Length と読み込んだ長さの両方で確かめ、
// 超えたら最後まで読まずに400 validation_failed。冪等キーの処理（idempotent）より前に置く
// （idempotent は本文を最後まで読んでハッシュを作り、idempotency_keys に行を作るため）

export function bodyLimit(maxBytes: number) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const declared = c.req.header("Content-Length");
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return validationFailed(c, null);
    const stream = c.req.raw.body;
    if (!stream) return next();
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return validationFailed(c, null);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // 読んだ本文で要求を作り直す（後ろの処理は、ふつうに c.req.text()・c.req.json() で読める）
    c.req.raw = new Request(c.req.raw, { body });
    await next();
  });
}
