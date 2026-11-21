import { describe, expect, it } from "vitest";
import { images } from "../../../test/images";
import { acceptImage, sniffType } from "./image";
import { isPublicAddress } from "./ip";
import { charsetOfContentType, cleanText, metaCharset, parseOgp } from "./parse";
import { fetchableUrl, parseOwnDomains } from "./url";

// docs/specs/T-08-link-preview.md「テスト計画」の domain の項目

const policy = { ownDomains: ["kokohima.app"], extraHosts: [] };
const ok = (u: string) => fetchableUrl(u, policy) !== null;

describe("取りに行ってよい URL", () => {
  it("http・https だけ、ポートは指定なしか既定の番号、userinfo なし", () => {
    expect(ok("https://example.com/a")).toBe(true);
    expect(ok("http://example.com/a")).toBe(true);
    expect(ok("http://example.com:80/")).toBe(true);
    expect(ok("https://example.com:443/")).toBe(true);
    expect(ok("https://example.com:8443/")).toBe(false);
    expect(ok("http://example.com:443/")).toBe(false);
    expect(ok("ftp://example.com/")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("https://user:pass@example.com/")).toBe(false);
    expect(ok("https://user@example.com/")).toBe(false);
  });

  it("IP アドレスのホストは取らない（解析で正規化された形も）", () => {
    for (const u of [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://0x7f000001/",
      "http://2130706433/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://8.8.8.8/",
    ]) {
      expect(ok(u), u).toBe(false);
    }
  });

  it("localhost・内部向けの接尾辞・末尾のドット・ドットなし・全角", () => {
    for (const u of [
      "http://localhost/",
      "http://localhost./",
      "http://a.localhost/",
      "http://foo.local/",
      "http://foo.local./",
      "http://db.internal/",
      "http://router.home.arpa/",
      "http://x.test/",
      "http://x.invalid/",
      "http://x.example/",
      "http://abc.onion/",
      "http://intranet/",
      "http://ｌｏｃａｌｈｏｓｔ/",
    ]) {
      expect(ok(u), u).toBe(false);
    }
    expect(fetchableUrl("https://example.com./a", policy)?.host).toBe("example.com");
  });

  it("自分のドメインとサブドメイン・workers.dev は取らない。末尾が似ているだけのものは通す", () => {
    expect(ok("https://kokohima.app/")).toBe(false);
    expect(ok("https://api.kokohima.app/")).toBe(false);
    expect(ok("https://evil-kokohima.app/")).toBe(true);
    expect(ok("https://kokohima.app.evil.com/")).toBe(true);
    expect(ok("https://workers.dev/")).toBe(false);
    expect(ok("https://x.y.workers.dev/")).toBe(false);
  });

  it("追加で許すホストは、内部向けの接尾辞でも通す（E2E）", () => {
    expect(fetchableUrl("https://ogp.e2e.invalid/a", { ownDomains: [], extraHosts: ["ogp.e2e.invalid"] })).not.toBeNull();
    expect(fetchableUrl("https://ogp.e2e.invalid:8443/a", { ownDomains: [], extraHosts: ["ogp.e2e.invalid"] })).toBeNull();
  });

  it("相対の URL は base から絶対にし、フラグメントを除く", () => {
    expect(fetchableUrl("/img.png#x", policy, "https://example.com/a/b")?.href).toBe("https://example.com/img.png");
    expect(fetchableUrl("//127.0.0.1/x", policy, "https://example.com/")).toBeNull();
  });

  it("LINK_PREVIEW_OWN_DOMAINS：空・読めない値は null", () => {
    expect(parseOwnDomains("kokohima.app, kokohima.jp")).toEqual(["kokohima.app", "kokohima.jp"]);
    expect(parseOwnDomains("")).toBeNull();
    expect(parseOwnDomains(undefined)).toBeNull();
    expect(parseOwnDomains("Kokohima.app")).toBeNull();
    expect(parseOwnDomains("kokohima.app,,x.jp")).toBeNull();
    expect(parseOwnDomains("https://kokohima.app")).toBeNull();
  });
});

describe("IP の検査", () => {
  it("IPv4 の範囲の境界", () => {
    expect(isPublicAddress("172.15.255.255")).toBe(true);
    expect(isPublicAddress("172.16.0.0")).toBe(false);
    expect(isPublicAddress("172.31.255.255")).toBe(false);
    expect(isPublicAddress("172.32.0.0")).toBe(true);
    for (const a of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "192.168.1.1", "192.0.2.5", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("100.63.255.255")).toBe(true);
    expect(isPublicAddress("100.128.0.0")).toBe(true);
  });

  it("IPv6 は 2000::/3 だけ。その中の Teredo・文書用・6to4 は拒む", () => {
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("2a00:1450:4001:81c::200e")).toBe(true);
    for (const a of [
      "::1",
      "::",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:127.0.0.1",
      "::127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::808:808",
      "2002:7f00:1::",
      "2001::1",
      "2001:db8::1",
      "3fff::1",
      "fec0::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
    ]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });

  it("読めない値は拒む", () => {
    for (const a of ["", "example.com", "1.2.3", "1.2.3.4.5", "01.2.3.4", "256.1.1.1", "1::2::3", "fe80::1%eth0", "12345::", ":1:2:3:4:5:6:7"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
  });
});

describe("解析", () => {
  const page = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

  it("og: と name の両方、property を優先し、最初の値を使う", () => {
    const ogp = parseOgp(
      page(`<meta property="og:title" content="タイトル">
        <meta name="og:description" content='説明'>
        <meta property="og:site_name" content=サイト>
        <meta property="og:image" content="/i.png">
        <meta property="og:title" content="2つめ">`),
    );
    expect(ogp).toEqual({ title: "タイトル", description: "説明", siteName: "サイト", image: "/i.png" });
  });

  it("og: がなければ <title> と description", () => {
    expect(parseOgp(page(`<title> 題 </title><meta name="description" content="説">`))).toEqual({
      title: "題",
      description: "説",
      siteName: null,
      image: null,
    });
  });

  it("文字参照を戻し、制御文字・書式文字を除き、空白を1つにする", () => {
    const ogp = parseOgp(page(`<meta property="og:title" content="A &amp; B &#x3042;&#12354; &lt;i&gt;\u200b  x\u0007y">`));
    expect(ogp?.title).toBe("A & B ああ <i> x y");
  });

  it("長さの上限で切る", () => {
    const ogp = parseOgp(
      page(`<meta property="og:title" content="${"あ".repeat(250)}"><meta property="og:description" content="${"い".repeat(400)}"><meta property="og:site_name" content="${"う".repeat(150)}">`),
    );
    expect(Array.from(ogp?.title ?? "")).toHaveLength(200);
    expect(Array.from(ogp?.description ?? "")).toHaveLength(300);
    expect(Array.from(ogp?.siteName ?? "")).toHaveLength(100);
  });

  it("<head> の外・コメント・script の中の meta は読まない", () => {
    expect(parseOgp(page("", `<meta property="og:title" content="体">`))).toBeNull();
    expect(parseOgp(page(`<!-- <meta property="og:title" content="x"> -->`))).toBeNull();
    expect(parseOgp(page(`<script>var s='<meta property="og:title" content="x">'</script>`))).toBeNull();
  });

  it("タイトルも説明もなければ null", () => {
    expect(parseOgp(page(`<meta property="og:image" content="/i.png">`))).toBeNull();
    expect(parseOgp(page(`<title>   </title>`))).toBeNull();
  });

  it("文字コードの指定を読む", () => {
    expect(charsetOfContentType("text/html; charset=Shift_JIS")).toBe("shift_jis");
    expect(charsetOfContentType('text/html; charset="euc-jp"')).toBe("euc-jp");
    expect(charsetOfContentType("text/html")).toBeNull();
    expect(metaCharset(`<meta charset="EUC-JP">`)).toBe("euc-jp");
    expect(metaCharset(`<meta http-equiv="Content-Type" content="text/html; charset=iso-2022-jp">`)).toBe("iso-2022-jp");
  });

  it("cleanText：null・空は null", () => {
    expect(cleanText(null, 10)).toBeNull();
    expect(cleanText(" \n ", 10)).toBeNull();
  });
});

describe("画像", () => {
  it("種類と先頭のバイトが合い、大きさが読めるときだけ受け付ける", () => {
    expect(acceptImage("image/png", images.png(100, 50))).toBe("image/png");
    expect(acceptImage("image/gif", images.gif(10, 10))).toBe("image/gif");
    expect(acceptImage("image/jpeg", images.jpeg(640, 480))).toBe("image/jpeg");
    expect(acceptImage("image/webp", images.webpX(800, 600))).toBe("image/webp");
    expect(acceptImage("image/webp", images.webpL(300, 200))).toBe("image/webp");
    expect(acceptImage("image/webp", images.webpLossy(320, 240))).toBe("image/webp");
    expect(acceptImage("IMAGE/PNG; x=1", images.png(1, 1))).toBe("image/png");
  });

  it("種類が合わない・SVG・HTML を画像と偽ったものは受け付けない", () => {
    expect(acceptImage("image/jpeg", images.png(10, 10))).toBeNull();
    expect(acceptImage("image/svg+xml", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(acceptImage("image/png", new TextEncoder().encode("<html><script>x</script>"))).toBeNull();
    expect(sniffType(new TextEncoder().encode("<svg"))).toBeNull();
  });

  it("幅か高さが4096を超える・読めないものは受け付けない", () => {
    expect(acceptImage("image/png", images.png(4096, 4096))).toBe("image/png");
    expect(acceptImage("image/png", images.png(4097, 10))).toBeNull();
    expect(acceptImage("image/gif", images.gif(10, 5000))).toBeNull();
    expect(acceptImage("image/jpeg", images.jpeg(5000, 10))).toBeNull();
    expect(acceptImage("image/webp", images.webpX(4097, 10))).toBeNull();
    expect(acceptImage("image/png", images.png(10, 10).subarray(0, 20))).toBeNull();
    expect(acceptImage("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
