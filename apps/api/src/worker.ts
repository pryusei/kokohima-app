import { createApp, defaultDeps } from "./app";
import { assignSyncs } from "./calendar/application/sync";
import type { AppDeps, Bindings, JobMessage } from "./env";
import { handleBatch } from "./jobs/consumer";
import { cleanupExpired, dispatchOutbox, runStep } from "./jobs/dispatch";

// Worker の入口（fetch・scheduled・queue）。本番とE2Eで共有する。E2E用の経路はここに足さない

export const CRON_OUTBOX = "* * * * *";
export const CRON_CALENDAR_SYNC = "*/15 * * * *";

/** 各処理は独立させ、1つが失敗しても後の処理は走る。失敗は cron_step_failed のログに出す（docs/specs/T-12-data-growth.md） */
export async function runScheduled(cron: string, env: Bindings, deps: AppDeps) {
  const ctx = { env, deps };
  if (cron === CRON_CALENDAR_SYNC) {
    await runStep("assign_syncs", () => assignSyncs(ctx));
    return;
  }
  await runStep("dispatch_outbox", () => dispatchOutbox(ctx));
  await cleanupExpired(ctx);
}

export function createWorker(overrides: Partial<AppDeps> = {}) {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = createApp(deps);
  return {
    app,
    deps,
    handler: {
      fetch: app.fetch,
      scheduled: async (event, env, ctx) => {
        ctx.waitUntil(runScheduled(event.cron, env, deps));
      },
      queue: async (batch, env) => {
        await handleBatch({ env, deps }, batch);
      },
    } satisfies ExportedHandler<Bindings, JobMessage>,
  };
}
