import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// migrations/0002_social.sql と一致させる。行がなければ「見せる」
export const sharingPolicies = sqliteTable(
  "sharing_policies",
  {
    ownerId: text("owner_id").notNull(),
    targetId: text("target_id").notNull(),
    visible: integer("visible", { mode: "boolean" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.ownerId, t.targetId] })],
);
