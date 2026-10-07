import { createApp, problem } from "../app";
import { e2eLogin } from "./login";

// E2E用のエントリ（wrangler の env.e2e でだけ使う）。本番のエントリからはimportしない
const app = createApp();

app.use("/__e2e__/*", async (c, next) => {
  if (c.env.E2E_MODE !== "1") {
    return problem(c.get("requestId"), 404, "not_found", "Not Found");
  }
  await next();
});

app.post("/__e2e__/login", e2eLogin);

export default app;
