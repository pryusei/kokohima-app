// HTML からの OGP の取り出し（docs/specs/T-08-link-preview.md「解析」）。<head> の中だけを読む

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 300;
export const SITE_NAME_MAX = 100;

export type Ogp = {
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** og:image の生の値（相対のまま。絶対にして確かめるのは application） */
  image: string | null;
};

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML の文字参照を戻す（数値と、よく使う名前だけ） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED[ref.toLowerCase()] ?? whole;
  });
}

/** 制御文字・書式文字を除き、連続する空白を1つにし、前後の空白を除いて、上限の文字数で切る。空なら null */
export function cleanText(raw: string | null | undefined, max: number): string | null {
  if (raw == null) return null;
  const text = decodeEntities(raw)
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

/** <head> の部分。</head> か <body があればその前まで */
export function headOf(html: string): string {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  return end === -1 ? html : html.slice(0, end);
}

/** タグの属性を読む（名前は小文字） */
export function attributesOf(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const body = tag.replace(/^<\s*[a-z]+/i, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) {
    const name = (m[1] ?? "").toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** HTML から OGP を取り出す。タイトルも説明もなければ null（failed） */
export function parseOgp(html: string): Ogp | null {
  // コメントと script・style の中身は読まない
  const head = headOf(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "");
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesOf(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const title = cleanText(meta.get("og:title"), TITLE_MAX) ?? cleanText(titleTag, TITLE_MAX);
  const description =
    cleanText(meta.get("og:description"), DESCRIPTION_MAX) ?? cleanText(meta.get("description"), DESCRIPTION_MAX);
  if (title === null && description === null) return null;
  const image = decodeEntities(meta.get("og:image") ?? "").trim();
  return {
    title,
    description,
    siteName: cleanText(meta.get("og:site_name"), SITE_NAME_MAX),
    image: image === "" ? null : image,
  };
}

/** <meta charset> か http-equiv の content の charset。なければ null */
export function metaCharset(head: string): string | null {
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesOf(m[0]);
    const charset = attrs.get("charset");
    if (charset) return charset.trim().toLowerCase();
    if ((attrs.get("http-equiv") ?? "").toLowerCase() === "content-type") {
      const c = charsetOfContentType(attrs.get("content") ?? "");
      if (c) return c;
    }
  }
  return null;
}

/** Content-Type の charset。なければ null */
export function charsetOfContentType(value: string): string | null {
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(value);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Content-Type の種類（小文字、引数なし） */
export const mediaTypeOf = (value: string | null) => (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
