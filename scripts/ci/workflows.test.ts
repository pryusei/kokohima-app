import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// GitHub Actions のワークフローの設定（docs/specs/T-30-ci-review.md「振る舞い」「テスト計画」）

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  container?: { image?: string; options?: string };
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, { branches?: string[]; paths?: string[]; "paths-ignore"?: string[] } | null>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: string };
  jobs: Record<string, Job>;
};

const read = (name: string) =>
  parse(readFileSync(join(import.meta.dirname, "../../.github/workflows", name), "utf8")) as Workflow;
const ci = read("ci.yml");
const e2e = read("e2e.yml");
const terraform = read("terraform.yml");

const runs = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
/** 分類のジョブが成功して文書だけのときだけ飛ばす（判定に失敗したときは回す側に倒す） */
const skipOnlyWhenDocs = (job: string) =>
  `\${{ !cancelled() && !(needs.${job}.result == 'success' && needs.${job}.outputs.docs_only == 'true') }}`;
/** 同じ PR は古い実行を取り消し、main への push はコミットごとに回す */
const CONCURRENCY = {
  group: "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.event.pull_request.number || github.sha }}",
  "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
};

describe("ci", () => {
  it("PR（宛先を絞らない）と main への push で回り、main 以外への push だけでは回らない", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    expect(ci.on.push?.branches).toEqual(["main"]);
    expect(ci.on.pull_request?.branches).toBeUndefined();
  });

  it("同じ PR の古い実行は取り消し、main への push は取り消さない", () => {
    expect(ci.concurrency).toEqual(CONCURRENCY);
  });

  it("changes は PR のときだけ文書だけかを出す", () => {
    expect(ci.jobs.changes?.if).toBe("github.event_name == 'pull_request'");
    expect(ci.jobs.changes?.outputs?.docs_only).toBe("${{ steps.classify.outputs.docs_only }}");
    expect(runs(ci.jobs.changes)).toContain('node scripts/ci/changes.mjs "$BASE"');
  });

  it("unit は文書だけのときだけ飛び、型チェック・lint・単体テスト・本番のビルドを回す", () => {
    const unit = ci.jobs.unit;
    expect(unit?.needs).toBe("changes");
    expect(unit?.if).toBe(skipOnlyWhenDocs("changes"));
    for (const command of ["pnpm typecheck", "pnpm lint", "pnpm test", "pnpm --filter api build:prod"]) {
      expect(runs(unit)).toContain(command);
    }
  });

  it("require-unit-tests はブランチ名によらずすべての PR で回り、自分で差分を取る", () => {
    const job = ci.jobs["require-unit-tests"];
    expect(job?.if).toBe("github.event_name == 'pull_request'");
    expect(job?.needs).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/head_ref|feat\//);
    expect(runs(job)).toContain('node scripts/ci/changes.mjs "$BASE" --require-unit-tests');
  });
});

describe("e2e", () => {
  it("main への PR・main への push・手動で回る", () => {
    expect(Object.keys(e2e.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(e2e.on.pull_request?.branches).toEqual(["main"]);
    expect(e2e.on.push?.branches).toEqual(["main"]);
  });

  it("同じ PR の古い実行は取り消し、main への push は取り消さない", () => {
    expect(e2e.concurrency).toEqual(CONCURRENCY);
  });

  it("prepare が文書だけかと、lockfile の Playwright の版を出す", () => {
    const prepare = e2e.jobs.prepare;
    expect(prepare?.outputs).toEqual({
      docs_only: "${{ steps.classify.outputs.docs_only }}",
      playwright: "${{ steps.playwright.outputs.playwright }}",
    });
    expect(runs(prepare)).toContain("node scripts/ci/playwright-version.mjs");
  });

  it("e2e は文書だけのときだけ飛び、lockfile と同じ版の Playwright のコンテナで回る", () => {
    const job = e2e.jobs.e2e;
    expect(job?.needs).toBe("prepare");
    expect(job?.if).toBe(skipOnlyWhenDocs("prepare"));
    expect(job?.container?.image).toBe("mcr.microsoft.com/playwright:v${{ needs.prepare.outputs.playwright }}-noble");
    expect(job?.container?.options).toContain("--ipc=host");
    expect(runs(job)).toContain("pnpm e2e");
  });

  it("ブラウザと OS の依存を入れない（コンテナに入っている）", () => {
    expect(runs(e2e.jobs.e2e)).not.toContain("playwright install");
  });
});

describe("ci と e2e の共通", () => {
  it("文書だけの変更をワークフローの paths-ignore で飛ばさない（必須チェックが待機中のまま止まるため）", () => {
    for (const workflow of [ci, e2e]) {
      for (const trigger of Object.values(workflow.on)) {
        expect(trigger?.["paths-ignore"]).toBeUndefined();
        expect(trigger?.paths).toBeUndefined();
      }
    }
  });

  it("ブランチ保護の必須チェックの名前（unit・require-unit-tests・e2e）を変えない", () => {
    expect(Object.keys(ci.jobs)).toEqual(expect.arrayContaining(["unit", "require-unit-tests"]));
    expect(Object.keys(e2e.jobs)).toContain("e2e");
  });
});

describe("terraform", () => {
  it("check は承認を待たず、秘密を使わずに、整形と検証をする", () => {
    const check = terraform.jobs.check;
    expect(check?.environment).toBeUndefined();
    expect(JSON.stringify(check)).not.toContain("secrets.");
    expect(runs(check)).toContain("terraform fmt -check -recursive infra/terraform");
    expect(runs(check)).toContain("init -backend=false");
    expect(runs(check)).toContain("validate");
  });

  it("plan は check のあと、承認（terraform-plan）を待ってから回る", () => {
    const plan = terraform.jobs.plan;
    expect(plan?.needs).toBe("check");
    expect(plan?.environment).toBe("terraform-plan");
    expect(runs(plan)).toContain("terraform plan");
    expect(runs(plan)).not.toMatch(/fmt|validate/);
  });
});

describe("すべてのワークフロー", () => {
  const all = { "ci.yml": ci, "e2e.yml": e2e, "terraform.yml": terraform };

  it.each(Object.entries(all))("%s のアクションはコミットの SHA で固定する", (_name, workflow) => {
    const uses = Object.values(workflow.jobs).flatMap((job) => (job.steps ?? []).flatMap((s) => (s.uses ? [s.uses] : [])));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it.each(Object.entries(all))("%s の権限は contents: read だけ", (_name, workflow) => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });
});
