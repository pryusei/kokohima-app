import type { PresetName } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getUserTimezone } from "../../identity/application/auth";
import { selectForCancel } from "../domain/calendarCancel";
import { expandRule } from "../domain/recurrence";
import { overlaps } from "../domain/slots";
import { checkManualSlot } from "../domain/validation";
import { addDays, DAY_MS, localDateOf, localToUtc, parseHhmm } from "../domain/zonedTime";
import * as repo from "../infra/repository";
import { getPresets, listMine } from "./availability";

// カレンダー連携（T-06）から使う availability のユースケース。calendar は availability の表を直接読み書きせず、ここを通す

type Ctx = { env: Bindings; deps: AppDeps };

export type PresetWindow = { date: string; preset: PresetName; startsAt: number; endsAt: number };

const PRESETS: PresetName[] = ["day", "evening", "night"];

/**
 * 候補の枠（docs/specs/T-06-calendar.md「カレンダーの空き」の手順2・5）。[from, to) を閲覧者のタイムゾーンの日付に分け、
 * 今のプリセットの枠を作る。開始が現在以前・T-03 で作れない（60日より先など）・自分のここ暇と重なる枠は外す。
 * 埋まりとの重なりは呼び出し側（calendar）で外す
 */
export async function presetWindows(ctx: Ctx, userId: string, from: number, to: number): Promise<PresetWindow[]> {
  const now = ctx.deps.now();
  const [timezone, presets] = await Promise.all([getUserTimezone(ctx.env, userId), getPresets(ctx, userId)]);
  const windows: PresetWindow[] = [];
  const last = localDateOf(to - 1, timezone);
  for (let date = localDateOf(from, timezone); date <= last; date = addDays(date, 1)) {
    for (const preset of PRESETS) {
      const start = parseHhmm(presets[preset].start);
      const end = parseHhmm(presets[preset].end);
      if (start === null || end === null) continue;
      const startsAt = localToUtc(date, start, timezone);
      const endsAt = localToUtc(date, end, timezone);
      if (endsAt <= startsAt || startsAt <= now || startsAt < from || startsAt >= to) continue;
      if (checkManualSlot(startsAt, endsAt, now) !== null) continue;
      windows.push({ date, preset, startsAt, endsAt });
    }
  }
  if (windows.length === 0) return windows;
  const first = windows[0]?.startsAt ?? from;
  const lastEnd = Math.max(...windows.map((w) => w.endsAt));
  const mine = await listMine(ctx, userId, first, lastEnd);
  return windows
    .filter((w) => !mine.some((m) => overlaps(w, m)))
    .sort((a, b) => a.startsAt - b.startsAt || PRESETS.indexOf(a.preset) - PRESETS.indexOf(b.preset));
}

export type CancelPlan = {
  manual: { id: string; startsAt: number; endsAt: number }[];
  recurrence: { ruleId: string; date: string; startsAt: number; endsAt: number }[];
};

/**
 * 取り消すここ暇を選ぶ（手順5）。終了が現在より後、前回の確認より前に作った、新しく入った埋まりと1分以上重なる枠。
 * くり返しはルールの作成日時で判定する
 */
export async function planCalendarCancel(
  ctx: Ctx,
  userId: string,
  newBusy: { startsAt: number; endsAt: number }[],
  createdBefore: number,
): Promise<CancelPlan> {
  if (newBusy.length === 0) return { manual: [], recurrence: [] };
  const now = ctx.deps.now();
  const from = Math.min(...newBusy.map((b) => b.startsAt));
  const to = Math.max(...newBusy.map((b) => b.endsAt));
  const [manualRows, ruleRows] = await Promise.all([
    repo.myManualWithCreatedAt(ctx.env.DB, userId, from, to, now),
    repo.listMyRules(ctx.env.DB, userId),
  ]);
  const exceptions = await repo.exceptionsFor(
    ctx.env.DB,
    ruleRows.map((r) => r.id),
    new Date(from - 2 * DAY_MS).toISOString().slice(0, 10),
  );
  const manual = selectForCancel(
    manualRows.map((m) => ({ id: m.id, startsAt: m.starts_at, endsAt: m.ends_at, createdAt: m.created_at })),
    newBusy,
    createdBefore,
    now,
  );
  const expanded = ruleRows.flatMap((r) =>
    expandRule(
      {
        id: r.id,
        weekday: r.weekday,
        startMinute: r.start_minute,
        endMinute: r.end_minute,
        label: null,
        timezone: r.timezone,
        exceptions: new Set(exceptions.get(r.id) ?? []),
      },
      from,
      to,
      now,
    ).map((e) => ({ ruleId: r.id, date: e.date, startsAt: e.startsAt, endsAt: e.endsAt, createdAt: r.created_at })),
  );
  const recurrence = selectForCancel(expanded, newBusy, createdBefore, now);
  return {
    manual: manual.map(({ id, startsAt, endsAt }) => ({ id, startsAt, endsAt })),
    recurrence: recurrence.map(({ ruleId, date, startsAt, endsAt }) => ({ ruleId, date, startsAt, endsAt })),
  };
}

export const planSize = (plan: CancelPlan) => plan.manual.length + plan.recurrence.length;

/** 取り消しの文（guard 付き）。取り消しがあれば AvailabilityCancelledByCalendar（取り消した枠の時刻だけ）も書く */
export function calendarCancelStatements(ctx: Ctx, userId: string, plan: CancelPlan, guard: repo.Guard) {
  const now = ctx.deps.now();
  const ranges = [...plan.manual, ...plan.recurrence]
    .map((s) => ({ startsAt: new Date(s.startsAt).toISOString(), endsAt: new Date(s.endsAt).toISOString() }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const event =
    ranges.length > 0
      ? {
          id: crypto.randomUUID(),
          payload: JSON.stringify({ userId, ranges, occurredAt: new Date(now).toISOString() }),
        }
      : null;
  return repo.calendarCancelStatements(
    ctx.env.DB,
    {
      userId,
      manualIds: plan.manual.map((m) => m.id),
      exceptions: plan.recurrence.map((r) => ({ ruleId: r.ruleId, date: r.date })),
      event,
      now,
    },
    guard,
  );
}
