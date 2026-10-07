import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../env";
import { problem } from "./problem";

// 入力検証の失敗（400 validation_failed）。どの項目が不正かだけを返し、入力値そのものは返さない
export function validationFailed(c: Context<AppEnv>, error: z.ZodError | null) {
  const errors = (error?.issues ?? []).map((i) => ({ path: i.path.join(".") || "(root)", code: i.code }));
  return problem(c.get("requestId"), 400, "validation_failed", "Validation failed", errors);
}
