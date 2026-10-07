import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 外部連携の共通の箱（全コンテキストで共有）。ここに書いたイベントをQueuesのconsumerが処理する
export const outbox = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at").notNull(),
  processedAt: integer("processed_at"),
});

export function outboxRow(type: string, payload: Record<string, unknown>, now: number) {
  return { id: crypto.randomUUID(), type, payload: JSON.stringify(payload), createdAt: now };
}
