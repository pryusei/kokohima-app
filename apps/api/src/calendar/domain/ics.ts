// .ics（RFC 5545）の組み立て（docs/specs/T-06-calendar.md「.ics」）。利用者が入れた文字列で別のプロパティや
// VEVENT を作れないよう、TEXT の値はエスケープし、行は75オクテットで折り返す

export type IcsEvent = {
  uid: string;
  stamp: number;
  startsAt: number;
  endsAt: number;
  summary: string;
  location: string;
  description: string;
  status: "CONFIRMED" | "CANCELLED";
  sequence: number;
};

/** TEXT の値のエスケープ（\ ; , 改行）。そのほかの制御文字は捨てる */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** 1行を75オクテットごとに折り返す（続きの行は空白1つで始める）。UTF-8 の文字の途中では切らない */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).byteLength;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + n > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** UTC の日時（20261010T110000Z） */
export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildIcs(event: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kokohima//kokohima//JA",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${icsDate(event.stamp)}`,
    `DTSTART:${icsDate(event.startsAt)}`,
    `DTEND:${icsDate(event.endsAt)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `DESCRIPTION:${escapeText(event.description)}`,
    `STATUS:${event.status}`,
    `SEQUENCE:${event.sequence}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
