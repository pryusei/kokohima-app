import { z } from "zod";

// 一覧のカーソル（api-conventions「ページング」）。並び順のキーと id を base64url の JSON にした不透明な文字列

const cursorSchema = z.object({ k: z.number().int(), id: z.string().max(64) });
export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 壊れたカーソルは null（呼び出し側で400にする） */
export function decodeCursor(value: string): Cursor | null {
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = cursorSchema.safeParse(JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
