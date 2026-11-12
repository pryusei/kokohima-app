import { createApp, defaultDeps } from "./app";
import { assignSyncs } from "./calendar/application/sync";
import type { AppDeps, Bindings, JobMessage } from "./env";
import { handleBatch } from "./jobs/consumer";
import { cleanupExpired, dispatchOutbox } from "./jobs/dispatch";

// Worker の入口（fetch・scheduled・queue）。本番とE2Eで共有する。E2E用の経路はここに足さない

export const CRON_OUTBOX = "* * * * *";
export const CRON_CALENDAR_SYNC = "*/15 * * * *";

export async function runScheduled(cron: string, env: Bindings, deps: AppDeps) {
  const ctx = { env, deps };
  if (cron === CRON_CALENDAR_SYNC) {
    await assignSyncs(ctx);
    return;
  }
  await dispatchOutbox(ctx);
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
