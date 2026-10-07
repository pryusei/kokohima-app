import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// migrations/0001_identity.sql と一致させる
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  email: text("email"),
  timezone: text("timezone").notNull().default("Asia/Tokyo"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const userIdentities = sqliteTable("user_identities", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  subject: text("subject").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  revokedAt: integer("revoked_at"),
});

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  replacedBy: text("replaced_by"),
});

export const oauthTransactions = sqliteTable("oauth_transactions", {
  stateHash: text("state_hash").primaryKey(),
  provider: text("provider").notNull(),
  nonce: text("nonce").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  bindingHash: text("binding_hash").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const loginCodes = sqliteTable("login_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  bindingHash: text("binding_hash").notNull(),
  returnTo: text("return_to").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
