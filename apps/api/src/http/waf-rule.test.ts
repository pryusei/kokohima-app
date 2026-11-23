import { describe, expect, it } from "vitest";

// WAF のカスタムルール（infra/terraform/envs/prod/waf.tf、docs/specs/T-26-wp-scan-block.md）の、遮断するパスの一覧を確かめる。
// Workers には fs がないので、vitest.config.ts が waf.tf を読んで渡す
declare const __WAF_TF__: string;

function list(name: string): string[] {
  const m = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(__WAF_TF__);
  if (!m) throw new Error(`${name} が waf.tf にありません`);
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}
const prefixes = list("scan_path_prefixes");
const exact = list("scan_path_exact");
const contains = list("scan_path_contains");

/** waf.tf の式と同じ判定（パスは小文字にしてから比べる） */
function blocked(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return prefixes.some((x) => p.startsWith(x)) || exact.includes(p) || contains.some((x) => p.includes(x));
}

describe("WAF のカスタムルール：脆弱性スキャンの遮断（T-26）", () => {
  it("一覧が仕様書どおり（先頭一致・全体一致・途中を含む）", () => {
    expect(prefixes).toEqual([
      "/wp-admin",
      "/wp-login.php",
      "/wp-content",
      "/wp-includes",
      "/wp-json",
      "/.git",
      "/.aws",
      "/.vscode",
      "/phpinfo.php",
      "/phpmyadmin",
    ]);
    expect(exact).toEqual(["/xmlrpc.php"]);
    expect(contains).toEqual(["/.env"]);
  });

  it.each([
    "/wp-admin/install.php",
    "/wp-login.php",
    "/WP-Login.php",
    "/wp-content/plugins/x.php",
    "/wp-json/wp/v2/users",
    "/xmlrpc.php",
    "/.env",
    "/.env.prod",
    "/.env.save",
    "/api/.env",
    "/stripe/.env",
    "/.git/config",
    "/.git/HEAD",
    "/.aws/credentials",
    "/.vscode/sftp.json",
    "/phpinfo.php",
    "/phpmyadmin/index.php",
  ])("スキャンのパスは遮断する：%s", (p) => {
    expect(blocked(p)).toBe(true);
  });

  it.each([
    "/",
    "/index.html",
    "/login",
    "/settings",
    "/settings/install",
    "/notifications",
    "/privacy",
    "/terms",
    "/sw.js",
    "/manifest.webmanifest",
    "/icon.svg",
    "/assets/index-Ciq4yeNk.js",
    "/api/v1/health/ready",
    "/api/v1/notifications/unread-count",
    "/api/v1/friend-availabilities",
    "/invite/abc123",
    "/envelope",
    "/wp",
    "/wpad",
  ])("アプリのパスは遮断しない：%s", (p) => {
    expect(blocked(p)).toBe(false);
  });

  it("式は変数の展開で組み立て、ルールは block 1つ（waf.tf の形）", () => {
    expect(__WAF_TF__).toContain('phase       = "http_request_firewall_custom"');
    expect(__WAF_TF__).toContain('action      = "block"');
    expect(__WAF_TF__.match(/action\s*=\s*"/g)).toHaveLength(1);
  });
});
