import { describe, expect, it } from "vitest";
import type { NotificationKind } from "./kinds";
import { escapeHtml, mailFor, safeOrigin } from "./mail";
import { DARK, LIGHT, MAIL_TOKENS } from "./mail-theme";

declare const __WEB_INDEX_CSS__: string;
const indexCss = __WEB_INDEX_CSS__;

const KINDS: NotificationKind[] = [
  "invite_received",
  "invite_declined",
  "invite_countered",
  "invite_skipped",
  "broadcast_received",
  "broadcast_decided",
  "meetup_confirmed",
  "meetup_cancelled",
  "meetup_left",
  "friend_added",
  "availability_cancelled",
  "calendar_reauth",
  "new_login",
];
const QUIET: NotificationKind[] = [
  "invite_declined",
  "invite_skipped",
  "meetup_cancelled",
  "meetup_left",
  "availability_cancelled",
  "calendar_reauth",
];
const app = { origin: "https://app.test", timezone: "Asia/Tokyo" };
const at = Date.UTC(2026, 9, 10, 0, 5);
const make = (kind: NotificationKind, device: string | null = "iPhone・Safari", origin = app.origin) =>
  mailFor({ kind, device, createdAt: at }, { ...app, origin });

describe("mailFor（HTML）", () => {
  it.each(KINDS)("%s：HTML と、同じ内容のテキストを作る", (kind) => {
    const mail = make(kind);
    expect(mail.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(mail.html).toContain('lang="ja"');
    expect(mail.html).toContain('name="color-scheme" content="light dark"');
    const firstLine = mail.text.split("\n")[0]!.replace(/。$/, "");
    expect(mail.html).toContain(escapeHtml(firstLine));
  });

  it("件名は T-07 のまま", () => {
    expect(make("invite_received").subject).toBe("ここ暇：新しいお知らせがあります");
    expect(make("new_login").subject).toBe("ここ暇：新しい端末でログインがありました");
  });

  it.each(KINDS)("%s：リンクは APP_ORIGIN のトップだけ。名前などを入れない", (kind) => {
    const { html } = make(kind);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(new Set(hrefs)).toEqual(new Set(["https://app.test"]));
    expect(html).not.toMatch(/<img/i);
  });

  it.each(QUIET)("%s：使う色はテーマの値だけ（赤・警告色を使わない）", (kind) => {
    const colors = new Set([...Object.values(LIGHT), ...Object.values(DARK)]);
    const used = make(kind).html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(used.length).toBeGreaterThan(0);
    for (const c of used) expect(colors.has(c.toLowerCase())).toBe(true);
    expect(make(kind).html).not.toMatch(/⚠|❗|🚨|❌/);
  });

  it("mail-theme の値が index.css のトークンと一致する", () => {
    const light = /:root\s*\{([^}]*)\}/.exec(indexCss)![1]!;
    const dark = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(indexCss)![1]!;
    const read = (block: string, key: string) => new RegExp(`--kh-${key}:\\s*(#[0-9a-fA-F]+);`).exec(block)?.[1];
    for (const key of MAIL_TOKENS) {
      expect(LIGHT[key], key).toBe(read(light, key));
      expect(DARK[key], key).toBe(read(dark, key) ?? read(light, key));
    }
  });

  it("新端末のログイン：端末の要約をエスケープし、日時を利用者のタイムゾーンで入れる", () => {
    const { html } = make("new_login", `<script>alert("x")</script>&'`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    expect(html).toContain("2026/10/10 9:05");
    expect(html).toContain("すべての端末からログアウト");
  });

  it("新端末のログイン：端末が不明なら「不明」", () => {
    expect(make("new_login", null).html).toContain("不明");
  });

  it("APP_ORIGIN が https でないとき（javascript: など）は href に入れない", () => {
    for (const origin of ["javascript:alert(1)", "http://evil.test", 'https://a.test/"><script>']) {
      const { html } = make("invite_received", "x", origin);
      expect(html).not.toContain("href=");
      expect(html).not.toContain("<script>");
    }
    expect(make("invite_received", "x", "http://localhost:5173").html).toContain('href="http://localhost:5173"');
  });

  it("safeOrigin", () => {
    expect(safeOrigin("https://kokohima.app")).toBe("https://kokohima.app");
    expect(safeOrigin("http://localhost")).toBe("http://localhost");
    expect(safeOrigin("http://localhost.evil.test")).toBeNull();
    expect(safeOrigin("ftp://x")).toBeNull();
  });
});
