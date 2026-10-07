import { z } from "zod";

// 一覧のページング（api-conventions「ページング」）。limit は1〜50（既定20）、cursor は不透明な文字列
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(256).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
