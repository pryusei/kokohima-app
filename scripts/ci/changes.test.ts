import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classify, parseNameStatus } from "./changes.mjs";

// PR の変更の分類（docs/specs/T-30-ci-review.md「1. 変更の分類」「テスト計画」）

/** 読みやすさのため「状態\tパス」の行で書き、git diff --name-status -z の形（NUL 区切り）にして渡す */
const z = (...lines: string[]) => lines.map((line) => `${line.split("\t").join("\0")}\0`).join("");
const of = (...lines: string[]) => classify(parseNameStatus(z(...lines)));

describe("git diff --name-status -z の読み取り", () => {
  it("状態の1文字とパスを読み、名前の変更は移動元と移動先を持つ", () => {
    expect(parseNameStatus("M\0apps/api/src/a.ts\0R100\0docs/old.md\0docs/new.md\0A\0apps/api/src/招待.ts\0")).toEqual([
      { status: "M", path: "apps/api/src/a.ts", paths: ["apps/api/src/a.ts"] },
      { status: "R", path: "docs/new.md", paths: ["docs/old.md", "docs/new.md"] },
      { status: "A", path: "apps/api/src/招待.ts", paths: ["apps/api/src/招待.ts"] },
    ]);
  });

  it("変更がなければ空", () => {
    expect(parseNameStatus("")).toEqual([]);
  });

  it("読めない出力は止める（分類を間違えたまま進めない）", () => {
    // -z でない形（タブと改行）
    expect(() => parseNameStatus("M\tapps/api/src/a.ts\n")).toThrow();
    // 名前の変更なのにパスが1つしかない
    expect(() => parseNameStatus("R100\0docs/old.md\0")).toThrow();
  });
});

describe("文書だけの変更（docsOnly）", () => {
  it.each([
    [["A\tdocs/specs/T-99-x.md", "A\tdocs/tasks/T-99-x.md"]],
    [["M\tCLAUDE.md"]],
    [["M\t.claude/skills/x/SKILL.md"]],
    [["M\t.github/pull_request_template.md"]],
    [["A\tdocs/app-guide.pdf"]],
    // 名前の変更は、移動元と移動先の両方が文書なら文書だけ
    [["R100\tdocs/specs/a.md\tdocs/specs/b.md"]],
  ])("%j は文書だけ", (lines) => {
    expect(of(...lines).docsOnly).toBe(true);
  });

  it.each([
    // コードの置き場所の下の .md は、テストやビルドで読むかもしれないので文書に数えない
    [["A\tdocs/specs/T-99-x.md", "M\tapps/web/README.md"]],
    // WAF のテストが読む
    [["A\tdocs/specs/T-99-x.md", "M\tinfra/terraform/envs/prod/waf.tf"]],
    [["A\tdocs/specs/T-99-x.md", "M\t.github/workflows/ci.yml"]],
    [["A\tdocs/specs/T-99-x.md", "M\tpnpm-lock.yaml"]],
    [["M\te2e/notes.md"]],
    // 名前の変更は、移動元も文書でなければ回す
    [["R100\tapps/web/src/x.md\tdocs/x.md"]],
  ])("%j は文書だけでない", (lines) => {
    expect(of(...lines).docsOnly).toBe(false);
  });

  it("変更がないときは文書だけにしない（念のため回す）", () => {
    expect(of().docsOnly).toBe(false);
  });
});

describe("単体テストを求めるか（needsUnitTest・hasUnitTest）", () => {
  it("コードを変えてテストがないと、求めるがない", () => {
    expect(of("M\tapps/api/src/x.ts")).toMatchObject({ needsUnitTest: true, hasUnitTest: false });
  });

  it.each([
    ["apps/api/src/x.test.ts"],
    ["apps/api/test/y.test.ts"],
    ["apps/web/src/z.test.tsx"],
    ["packages/shared/src/s.test.ts"],
    ["e2e/w.unit.ts"],
    ["scripts/ci/v.test.ts"],
  ])("%s を足す・変えると、テストがある", (test) => {
    expect(of("M\tapps/api/src/x.ts", `A\t${test}`)).toMatchObject({ needsUnitTest: true, hasUnitTest: true });
    expect(of("M\tapps/api/src/x.ts", `M\t${test}`).hasUnitTest).toBe(true);
  });

  it("テストを消しただけでは、テストがあるにならない", () => {
    expect(of("M\tapps/api/src/x.ts", "D\tapps/api/src/x.test.ts")).toMatchObject({ needsUnitTest: true, hasUnitTest: false });
  });

  it("コードを消しただけなら、テストを求めない", () => {
    expect(of("D\tapps/api/src/x.ts").needsUnitTest).toBe(false);
  });

  it("名前の変更は移動先のパスで判定する", () => {
    expect(of("R100\tdocs/x.ts\tapps/api/src/x.ts").needsUnitTest).toBe(true);
    expect(of("R100\tapps/api/src/x.ts\tdocs/x.ts").needsUnitTest).toBe(false);
    expect(of("M\tapps/api/src/x.ts", "R090\tapps/api/src/old.test.ts\tapps/api/src/new.test.ts").hasUnitTest).toBe(true);
  });

  it("依存の更新（package.json と lockfile だけ）は、テストを求めず、テストは回す", () => {
    expect(of("M\tapps/web/package.json", "M\tpnpm-lock.yaml")).toEqual({ docsOnly: false, needsUnitTest: false, hasUnitTest: false });
  });

  it.each([["e2e/x.spec.ts"], ["infra/terraform/envs/prod/dns.tf"], [".github/workflows/e2e.yml"], ["playwright.config.ts"], ["apps/web/README.md"]])(
    "%s だけなら、テストを求めない",
    (path) => {
      expect(of(`M\t${path}`).needsUnitTest).toBe(false);
    },
  );

  it.each([["apps/api/migrations/0099_x.sql"], ["apps/web/public/sw.js"], ["scripts/ci/changes.mjs"], ["packages/shared/src/x.ts"]])(
    "%s を変えたら、テストを求める",
    (path) => {
      expect(of(`M\t${path}`).needsUnitTest).toBe(true);
    },
  );
});

describe("コマンド（CI から呼ぶ形）", () => {
  const script = join(import.meta.dirname, "changes.mjs");
  let repo = "";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const write = (path: string, text = "x\n") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  /** main から枝分かれして files を足したリポジトリで、スクリプトを走らせる */
  const run = (files: string[], ...flags: string[]) => {
    repo = mkdtempSync(join(tmpdir(), "changes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "ci");
    write("README.md");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "pr");
    for (const f of files) write(f);
    git("add", ".");
    git("commit", "-q", "-m", "pr");
    const output = join(repo, "github-output");
    writeFileSync(output, "");
    const r = spawnSync(process.execPath, [script, "main", ...flags], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: readFileSync(output, "utf8") };
  };

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = "";
  });

  it("文書だけの PR は docs_only=true を書き、単体テストの検査も通る", () => {
    const r = run(["docs/specs/T-99-x.md"], "--require-unit-tests");
    expect(r.status).toBe(0);
    expect(r.output).toBe("docs_only=true\n");
  });

  it("コードを変えて単体テストのない PR は、検査で落ちる", () => {
    const r = run(["apps/api/src/x.ts"], "--require-unit-tests");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("::error::実装PRには単体テスト");
    expect(r.output).toBe("docs_only=false\n");
  });

  it.each([["apps/api/src/invitation/招待.ts"], ['apps/api/src/invitation/a"b.ts']])(
    "日本語や引用符を含むパスのコード（%s）も、テストがなければ検査で落ちる（git が引用符で囲んでも数える）",
    (path) => {
      expect(run([path], "--require-unit-tests").status).toBe(1);
    },
  );

  it("日本語のファイル名の文書だけの PR は、文書だけになる", () => {
    expect(run(["docs/設計メモ.md"]).output).toBe("docs_only=true\n");
  });

  it("単体テストを足した PR は、検査を通る", () => {
    expect(run(["apps/api/src/x.ts", "apps/api/src/x.test.ts"], "--require-unit-tests").status).toBe(0);
  });

  it("検査を頼まなければ、テストがなくても落とさない（分類だけ）", () => {
    expect(run(["apps/api/src/x.ts"]).status).toBe(0);
  });

  it("比べる先がなければ止める", () => {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});
