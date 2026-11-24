import { DEFAULT_PRESETS, type FreeSlot, type MyAvailability, type PresetName, type Presets } from "@kokohima/shared";
import { addDays, formatDate, formatSlot, formatTime, localDateOf, localInstant, PRESET_LABELS, PRESET_NAMES, startOfLocalDay } from "./format";

// ここ暇タブの週の帯（docs/specs/T-55-availability-week-grid.md「振る舞い」）。画面に依らない計算だけを置く
// マス＝日付×時間帯（昼・夕方・夜）。自分のここ暇を、どのマスに入れるかを決める

/** 1枚に出す日数と、見られる週の数（今日から14日。自分のここ暇の一覧の範囲と同じ） */
export const WEEK_DAYS = 7;
export const WEEK_COUNT = 2;

export type Cell = { date: string; preset: PresetName };
export const cellKey = (date: string, preset: PresetName) => `${date}|${preset}`;

/** 自分のここ暇の一意なキー（API の (source, id, date)） */
export const itemKey = (i: Pick<MyAvailability, "source" | "id" | "date">) => `${i.source}|${i.id}|${i.date ?? ""}`;

/** 何週めかの7日の日付（week は 0 か 1） */
export function weekDates(today: string, week: number) {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(today, week * WEEK_DAYS + i));
}

/** プリセットの時刻の瞬間。終了の 24:00 は翌日の 0:00 */
export function presetInstant(date: string, hhmm: string) {
  return hhmm === "24:00" ? startOfLocalDay(addDays(date, 1)) : localInstant(date, hhmm);
}

export const presetRange = (presets: Presets, date: string, preset: PresetName) => ({
  start: presetInstant(date, presets[preset].start),
  end: presetInstant(date, presets[preset].end),
});

/** 「19:00〜23:00」 */
export const presetTime = (presets: Presets, preset: PresetName) => `${presets[preset].start}〜${presets[preset].end}`;

/**
 * ここ暇がどのマスに入るか。
 * - 日付は開始の日付。今日より前に始まった枠（今から暇）は今日に入れる
 * - プリセットの名前（label）があれば、その時間帯
 * - なければ（時刻を指定して作った枠）、その日の今のプリセットのうち重なりの一番長い時間帯。重ならなければ一番近い時間帯。
 *   同じなら早い時間帯
 */
export function cellOf(item: Pick<MyAvailability, "startsAt" | "endsAt" | "label">, presets: Presets, today: string): Cell {
  const startDate = localDateOf(item.startsAt);
  const date = startDate < today ? today : startDate;
  if (item.label) return { date, preset: item.label };
  const start = Math.max(Date.parse(item.startsAt), startOfLocalDay(date));
  const end = Date.parse(item.endsAt);
  let best: PresetName = "day";
  let bestScore = -Infinity;
  for (const preset of PRESET_NAMES) {
    const range = presetRange(presets, date, preset);
    // 重なりの長さ（正）か、離れている長さ（負）
    const score = Math.min(end, range.end) - Math.max(start, range.start);
    if (score > bestScore) {
      best = preset;
      bestScore = score;
    }
  }
  return { date, preset: best };
}

/** マスごとのここ暇（API の並び順のまま） */
export function itemsByCell(items: MyAvailability[], presets: Presets, today: string) {
  const cells = new Map<string, MyAvailability[]>();
  for (const item of items) {
    const { date, preset } = cellOf(item, presets, today);
    const key = cellKey(date, preset);
    cells.set(key, [...(cells.get(key) ?? []), item]);
  }
  return cells;
}

/** カレンダーの空きの候補（T-06）があるマス */
export const freeCells = (slots: FreeSlot[]) => new Set(slots.map((s) => cellKey(s.date, s.preset)));

/** 時間帯の終わりが過ぎたマス（作っても400になる。T-03「終了が現在より前の枠は作れない」） */
export const isPast = (presets: Presets, cell: Cell, now: number) => presetRange(presets, cell.date, cell.preset).end <= now;

/** 枠の時刻だけ（「20:30〜23:30」） */
export const itemTime = (item: Pick<MyAvailability, "startsAt" | "endsAt">) => formatSlot({ ...item, label: null });

/** 枠の開始の時刻（「20:30」） */
export const itemStart = (item: Pick<MyAvailability, "startsAt">) => formatTime(item.startsAt);

export type CellState =
  | { kind: "empty"; free: boolean }
  | { kind: "past" }
  | { kind: "one"; item: MyAvailability }
  | { kind: "many"; items: MyAvailability[] };

export function cellState(items: MyAvailability[] | undefined, free: boolean, past: boolean): CellState {
  if (!items || items.length === 0) return past ? { kind: "past" } : { kind: "empty", free };
  if (items.length === 1 && items[0]) return { kind: "one", item: items[0] };
  return { kind: "many", items };
}

/** マスの読み上げの名前。日付・時間帯・状態・押すと何が起きるか */
export function cellName(cell: Cell, state: CellState, presets: Presets = DEFAULT_PRESETS) {
  const base = `${formatDate(cell.date)} ${PRESET_LABELS[cell.preset]}`;
  switch (state.kind) {
    case "past":
      return `${base} 過ぎた時間帯`;
    case "empty":
      return `${base} ${presetTime(presets, cell.preset)}${state.free ? " カレンダーで空き" : ""}。押すとここ暇にする`;
    case "one":
      return state.item.source === "recurrence"
        ? `${base} くり返しのここ暇 ${itemTime(state.item)}。押すとこの日だけ外す`
        : `${base} ここ暇 ${itemTime(state.item)}。押すと取り消す`;
    case "many":
      return `${base} ここ暇が${state.items.length}つ。押すと選べる`;
  }
}

/** マスの中に出す短い文字。時間帯に合う枠は「暇」、時刻を指定した枠は開始の時刻、2つ以上は数 */
export function cellText(cell: Cell, state: CellState) {
  if (state.kind === "one") return state.item.label === cell.preset ? "暇" : itemStart(state.item);
  if (state.kind === "many") return `${state.items.length}つ`;
  return "";
}

/**
 * 取り消したここ暇を戻すときに送る本文。プリセットの名前があり、時刻が今のプリセットと同じなら日付とプリセット
 * （名前を残す）。違えば開始・終了の時刻
 */
export function restoreBody(item: MyAvailability, presets: Presets) {
  if (item.label) {
    const date = localDateOf(item.startsAt);
    const range = presetRange(presets, date, item.label);
    if (range.start === Date.parse(item.startsAt) && range.end === Date.parse(item.endsAt)) return { date, preset: item.label };
  }
  return { startsAt: item.startsAt, endsAt: item.endsAt };
}

/** 押したらすぐ見せるための仮の枠（応答で本物に置き換える） */
export function draftItem(presets: Presets, cell: Cell): MyAvailability {
  const range = presetRange(presets, cell.date, cell.preset);
  return {
    source: "manual",
    id: `draft-${cellKey(cell.date, cell.preset)}`,
    date: null,
    startsAt: new Date(range.start).toISOString(),
    endsAt: new Date(range.end).toISOString(),
    label: cell.preset,
  };
}

/** 「11/24〜11/30」 */
export function weekRangeText(dates: string[]) {
  const md = (d: string | undefined) => (d ? formatDate(d).replace(/（.）$/, "") : "");
  return `${md(dates[0])}〜${md(dates[dates.length - 1])}`;
}
