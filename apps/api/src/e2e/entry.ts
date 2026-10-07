import { createApp, problem } from "../app";

// E2E用のエントリ（wrangler の env.e2e でだけ使う）。本番のエントリからはimportしない
// テスト用ログイン（POST /__e2e__/login）は T-01 で実装する
const app = createApp();

app.use("/__e2e__/*", async (c, next) => {
  if (c.env.E2E_MODE !== "1") {
    return problem(c.get("requestId"), 404, "not_found", "Not Found");
  }
  await next();
});

export default app;
