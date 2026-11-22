import { createApp, defaultDeps } from "./app";
import { assignSyncs } from "./calendar/application/sync";
import type { AppDeps, Bindings, JobMessage } from "./env";
import { isApiPath, withApiHeaders, withPageHeaders } from "./http/securityHeaders";
import { handleBatch } from "./jobs/consumer";
import { cleanupExpired, dispatchOutbox, recordCronRun, runStep } from "./jobs/dispatch";

// Worker の入口（fetch・scheduled・queue）。本番とE2Eで共有する。E2E用の経路はここに足さない

export const CRON_OUTBOX = "* * * * *";
export const CRON_CALENDAR_SYNC = "*/15 * * * *";

/** 各処理は独立させ、1つが失敗しても後の処理は走る。失敗は cron_step_failed のログに出す（docs/specs/T-12-data-growth.md） */
export async function runScheduled(cron: string, env: Bindings, deps: AppDeps) {
  const ctx = { env, deps };
  if (cron === CRON_CALENDAR_SYNC) {
    await runStep("assign_syncs", () => assignSyncs(ctx));
    // 途中の処理が失敗していても、定期処理が動いたことは記録する（停止は /api/v1/health/ready で外から見る。T-13）
    await runStep("heartbeat", () => recordCronRun(env.DB, "calendar_sync", deps.now()));
    return;
  }
  await runStep("dispatch_outbox", () => dispatchOutbox(ctx));
  await cleanupExpired(ctx);
  await runStep("heartbeat", () => recordCronRun(env.DB, "minutely", deps.now()));
}

/**
 * 要求の振り分け（docs/specs/T-12-release.md「振り分け」）。`/api/` は API、それ以外は画面の静的アセット（ASSETS があるとき）。
 * ASSETS がない環境（ローカル・E2E・単体テスト）は、今までどおりすべて API のアプリが受ける。どの応答にもセキュリティのヘッダーを付ける
 */
export async function routeRequest(
  app: { fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => Response | Promise<Response> },
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isApiPath(pathname) || !env.ASSETS) return withApiHeaders(await app.fetch(request, env, ctx));
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withPageHeaders(pathname, new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }));
  }
  return withPageHeaders(pathname, await env.ASSETS.fetch(request));
}

export function createWorker(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = createApp(deps);
  return {
    app,
    deps,
    handler: {
      fetch: (request, env, ctx) => routeRequest(app, request, env, ctx),
      scheduled: async (event, env, ctx) => {
        ctx.waitUntil(runScheduled(event.cron, env, deps));
      },
      queue: async (batch, env) => {
        await handleBatch({ env, deps }, batch);
      },
    } satisfies ExportedHandler<Bindings, JobMessage>,
  };
}
