// User-Agent から「ブラウザ名 / OS名」の要約を作る。全文は保存しない

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const OSES: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];

export function deviceSummary(userAgent: string | null | undefined): string {
  if (!userAgent) return "unknown";
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1];
  const os = OSES.find(([re]) => re.test(userAgent))?.[1];
  if (!browser && !os) return "unknown";
  return `${browser ?? "unknown"} / ${os ?? "unknown"}`.slice(0, 64);
}
