import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// manifest・アイコン・index.html（docs/specs/T-25-installable-pwa.md「アイコンと manifest」）
// public/ と index.html は apps/web の直下。このファイルからの相対で読む

const read = (p: string) => readFileSync(resolve(import.meta.dirname, "../..", p));
type Icon = { src: string; sizes: string; type: string; purpose: string };
const manifest = JSON.parse(read("public/manifest.webmanifest").toString()) as {
  id: string;
  scope: string;
  display: string;
  start_url: string;
  icons: Icon[];
};

/** PNG のヘッダーから実際の大きさを読む */
function pngSize(buf: Buffer) {
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe("manifest", () => {
  it("id・scope・display・start_url", () => {
    expect(manifest).toMatchObject({ id: "/", scope: "/", display: "standalone", start_url: "/" });
  });

  it("PNG（192・512）と maskable（512）があり、画像の実際の大きさが宣言と一致する", () => {
    const find = (sizes: string, purpose: string) => manifest.icons.find((i) => i.sizes === sizes && i.purpose === purpose && i.type === "image/png");
    expect(find("192x192", "any")).toBeDefined();
    expect(find("512x512", "any")).toBeDefined();
    expect(find("512x512", "maskable")).toBeDefined();
    for (const icon of manifest.icons.filter((i) => i.type === "image/png")) {
      expect(pngSize(read(`public${icon.src}`))).toBe(icon.sizes);
    }
  });

  it("start_url に利用者の情報・トークンを入れない", () => {
    expect(manifest.start_url).not.toMatch(/[?#]/);
  });

  it("apple-touch-icon は 180×180 で、透過しない", () => {
    const buf = read("public/apple-touch-icon.png");
    expect(pngSize(buf)).toBe("180x180");
    expect(buf[25]).toBe(2); // カラータイプ2＝RGB（アルファなし）
  });
});

describe("index.html", () => {
  const html = read("index.html").toString();
  it("manifest・apple-touch-icon・theme-color（ライト・ダーク）がある", () => {
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
    expect(html).toMatch(/name="theme-color" content="#fcd34d" media="\(prefers-color-scheme: light\)"/);
    expect(html).toMatch(/name="theme-color" content="#1b1a17" media="\(prefers-color-scheme: dark\)"/);
  });
});
