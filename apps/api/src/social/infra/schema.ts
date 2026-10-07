import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// migrations/0002_social.sql と一致させる
export const inviteLinks = sqliteTable("invite_links", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  maxUses: integer("max_uses").notNull(),
  uses: integer("uses").notNull().default(0),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
  createdAt: integer("created_at").notNull(),
});

/** 1組の友達を両方向の2行で持つ */
export const friendships = sqliteTable(
  "friendships",
  {
    userId: text("user_id").notNull(),
    friendId: text("friend_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] })],
);
