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

/**
 * コメントと script・style の中身を除く。左から1回だけ見ていく（閉じがなければ残りを捨てて終える）ので、
 * 閉じのない開始が多数あっても、ページの大きさに比例する時間で終わる
 */
export function stripIgnored(text: string): string {
  const lower = text.toLowerCase();
  let out = "";
  let i = 0;
  for (;;) {
    const next = lower.indexOf("<", i);
    if (next === -1) return out + text.slice(i);
    let closer: string | null = null;
    if (lower.startsWith("<!--", next)) closer = "-->";
    else if (/^<(script|style)[\s>/]/.test(lower.slice(next, next + 8))) closer = lower.startsWith("<script", next) ? "</script" : "</style";
    if (closer === null) {
      out += text.slice(i, next + 1);
      i = next + 1;
      continue;
    }
    out += text.slice(i, next);
    const end = lower.indexOf(closer, next + 4);
    if (end === -1) return out;
    const gt = closer === "-->" ? end + 2 : lower.indexOf(">", end);
    if (gt === -1) return out;
    i = gt + 1;
  }
}

/** <meta ...> のタグを左から順に。閉じの > がなければそこで終える（ページの大きさに比例する時間） */
export function* metaTags(text: string): Generator<string> {
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const start = lower.indexOf("<meta", i);
    if (start === -1) return;
    const after = lower[start + 5] ?? "";
    if (!/[\s/>]/.test(after)) {
      i = start + 5;
      continue;
    }
    const end = lower.indexOf(">", start);
    if (end === -1) return;
    yield text.slice(start, end + 1);
    i = end + 1;
  }
}

/** 最初の <title> の中身。閉じがなければ null */
export function titleOf(text: string): string | null {
  const lower = text.toLowerCase();
  let i = 0;
  for (;;) {
    const start = lower.indexOf("<title", i);
    if (start === -1) return null;
    if (!/[\s>]/.test(lower[start + 6] ?? "")) {
      i = start + 6;
      continue;
    }
    const open = lower.indexOf(">", start);
    if (open === -1) return null;
    const close = lower.indexOf("</title", open);
    return close === -1 ? null : text.slice(open + 1, close);
  }
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
  const head = stripIgnored(headOf(html));
  const meta = new Map<string, string>();
  for (const tag of metaTags(head)) {
    const attrs = attributesOf(tag);
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = titleOf(head);
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
  for (const tag of metaTags(head)) {
    const attrs = attributesOf(tag);
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
