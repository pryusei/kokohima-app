import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// 各テストファイルの前にマイグレーションを適用する（適用済みなら何もしない）
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
