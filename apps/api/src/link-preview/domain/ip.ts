// 名前解決で返ったアドレスの検査（docs/specs/T-08-link-preview.md「名前解決の検査」）。
// IPv4 は拒否の一覧、IPv6 は 2000::/3 の許可の一覧で判定する。読めない値は拒む（fail closed）

const IPV4_DENY: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

/** 2000::/3 の中でも取らない範囲（Teredo・文書用・6to4） */
const IPV6_DENY_IN_GLOBAL: readonly [string, number][] = [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["2002::", 16],
];

/** 10進の4つ組だけを読む（先頭の0・範囲外は読めない値） */
export function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv6 を8つの16ビットの値にする（末尾の IPv4 の埋め込みも読む）。読めなければ null */
export function parseIpv6(value: string): number[] | null {
  const text = value.toLowerCase();
  if (text.includes("%") || !/^[0-9a-f:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? "";
      if (item.includes(".")) {
        if (i !== items.length - 1) return null;
        const v4 = parseIpv4(item);
        if (v4 === null) return null;
        out.push(Math.floor(v4 / 65536), v4 % 65536);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
        out.push(parseInt(item, 16));
      }
    }
    return out;
  };
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  // 埋め込みの IPv4 は最後の部分にだけ置ける
  if (halves.length === 2 && (halves[0] ?? "").includes(".")) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

const inV4 = (addr: number, [base, bits]: readonly [string, number]) => {
  const b = parseIpv4(base) ?? 0;
  const size = 2 ** (32 - bits);
  return Math.floor(addr / size) === Math.floor(b / size);
};

const inV6 = (groups: number[], [base, bits]: readonly [string, number]) => {
  const b = parseIpv6(base) ?? [];
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const shift = 16 - take;
    if ((groups[i] ?? 0) >> shift !== (b[i] ?? 0) >> shift) return false;
    remaining -= take;
  }
  return true;
};

/** 公開のアドレス（取りに行ってよい）なら true。内部・特別な用途・読めない値は false */
export function isPublicAddress(value: string): boolean {
  const v4 = parseIpv4(value);
  if (v4 !== null) return !IPV4_DENY.some((r) => inV4(v4, r));
  const v6 = parseIpv6(value);
  if (v6 === null) return false;
  if (!inV6(v6, ["2000::", 3])) return false;
  return !IPV6_DENY_IN_GLOBAL.some((r) => inV6(v6, r));
}
