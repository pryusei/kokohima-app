import {
  DEFAULT_PRESETS,
  type CreateAvailabilityRequest,
  type CreateRecurrenceRuleRequest,
  type PresetName,
  type Presets,
} from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles, getUserTimezone } from "../../identity/application/auth";
import type { Cursor } from "../../shared/cursor";
import { expandRule, type RecurrenceRule } from "../domain/recurrence";
import { buildFriendSlots, mergeSlots, pageAfter, type Label, type Slot } from "../domain/slots";
import { checkLocalRange, checkManualSlot, HORIZON_MS, MAX_FUTURE_MANUAL, MAX_RULES } from "../domain/validation";
import { addDays, DAY_MS, formatHhmm, localDateOf, localToUtc, parseHhmm, weekdayOf } from "../domain/zonedTime";
import * as repo from "../infra/repository";

// ここ暇のユースケース（docs/specs/T-03-availability.md「振る舞い」）
// 閲覧者IDは呼び出し側（requireAuth）から受け取り、body・query のユーザーIDは使わない

type Ctx = { env: Bindings; deps: AppDeps };

const iso = (ms: number) => new Date(ms).toISOString();
const asLabel = (v: string | null): Label | null => (v === "day" || v === "evening" || v === "night" ? v : null);

// ---- 時間帯プリセット ----

function presetsFromRow(row: repo.PresetRow | null): Presets {
  if (!row) return DEFAULT_PRESETS;
  return {
    day: { start: formatHhmm(row.day_start), end: formatHhmm(row.day_end) },
    evening: { start: formatHhmm(row.evening_start), end: formatHhmm(row.evening_end) },
    night: { start: formatHhmm(row.night_start), end: formatHhmm(row.night_end) },
  };
}

export async function getPresets(ctx: Ctx, viewerId: string): Promise<Presets> {
  return presetsFromRow(await repo.getPresets(ctx.env.DB, viewerId));
}

/** 3つまとめて置き換える。不正なら null */
export async function putPresets(ctx: Ctx, viewerId: string, presets: Presets): Promise<Presets | null> {
  const minutes = (["day", "evening", "night"] as const).map((name) => {
    const start = parseHhmm(presets[name].start);
    const end = parseHhmm(presets[name].end);
    return start !== null && end !== null && checkLocalRange(start, end) ? { start, end } : null;
  });
  const [day, evening, night] = minutes;
  if (!day || !evening || !night) return null;
  await repo.putPresets(
    ctx.env.DB,
    viewerId,
    {
      day_start: day.start,
      day_end: day.end,
      evening_start: evening.start,
      evening_end: evening.end,
      night_start: night.start,
      night_end: night.end,
    },
    ctx.deps.now(),
  );
  return getPresets(ctx, viewerId);
}

// ---- 自分のここ暇 ----

export type CreateResult =
  | { kind: "created"; slot: { id: string; startsAt: number; endsAt: number; label: Label | null } }
  | { kind: "invalid" }
  | { kind: "conflict" };

export async function createAvailability(ctx: Ctx, viewerId: string, input: CreateAvailabilityRequest): Promise<CreateResult> {
  const now = ctx.deps.now();
  let startsAt: number;
  let endsAt: number;
  let label: Label | null = null;
  if ("preset" in input) {
    const timezone = await getUserTimezone(ctx.env, viewerId);
    const preset = (await getPresets(ctx, viewerId))[input.preset];
    const start = parseHhmm(preset.start);
    const end = parseHhmm(preset.end);
    if (start === null || end === null || !isValidDate(input.date)) return { kind: "invalid" };
    startsAt = localToUtc(input.date, start, timezone);
    endsAt = localToUtc(input.date, end, timezone);
    label = input.preset;
    // 夏時間の切り替えで終了が開始以前になったら作らない
    if (endsAt <= startsAt) return { kind: "invalid" };
  } else {
    startsAt = Date.parse(input.startsAt);
    endsAt = Date.parse(input.endsAt);
  }
  if (checkManualSlot(startsAt, endsAt, now) !== null) return { kind: "invalid" };
  const id = crypto.randomUUID();
  // 重なりと上限の判定は追加と1つの文で行う（二重押しでも重複しない）
  const inserted = await repo.insertManualWithinLimits(
    ctx.env.DB,
    { id, userId: viewerId, startsAt, endsAt, label, now },
    MAX_FUTURE_MANUAL,
  );
  return inserted ? { kind: "created", slot: { id, startsAt, endsAt, label } } : { kind: "conflict" };
}

function isValidDate(date: string) {
  try {
    weekdayOf(date);
    return true;
  } catch {
    return false;
  }
}

export type MyItem = {
  source: "manual" | "recurrence";
  id: string;
  date: string | null;
  startsAt: number;
  endsAt: number;
  label: Label | null;
};

async function rulesWithExceptions(ctx: Ctx, rows: repo.RuleRow[], sinceDate: string): Promise<RecurrenceRule[]> {
  const exceptions = await repo.exceptionsFor(
    ctx.env.DB,
    rows.map((r) => r.id),
    sinceDate,
  );
  return rows.map((r) => ({
    id: r.id,
    weekday: r.weekday,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    label: asLabel(r.label),
    timezone: r.timezone,
    exceptions: new Set(exceptions.get(r.id) ?? []),
  }));
}

/** 例外は範囲の前後1日まで見れば足りる */
const exceptionSince = (from: number) => new Date(from - 2 * DAY_MS).toISOString().slice(0, 10);

/** 自分の手動の枠とくり返しの展開。開始日時→id→date の順 */
export async function listMine(ctx: Ctx, viewerId: string, from: number, to: number): Promise<MyItem[]> {
  const now = ctx.deps.now();
  const [manual, ruleRows] = await Promise.all([
    repo.listMyManual(ctx.env.DB, viewerId, from, to, now),
    repo.listMyRules(ctx.env.DB, viewerId),
  ]);
  const rules = await rulesWithExceptions(ctx, ruleRows, exceptionSince(from));
  const items: MyItem[] = [
    ...manual.map((m) => ({
      source: "manual" as const,
      id: m.id,
      date: null,
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      label: asLabel(m.label),
    })),
    ...rules.flatMap((rule) =>
      expandRule(rule, from, to, now).map((e) => ({
        source: "recurrence" as const,
        id: e.ruleId,
        date: e.date,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        label: e.label,
      })),
    ),
  ];
  return items.sort(
    (a, b) =>
      a.startsAt - b.startsAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.date ?? "").localeCompare(b.date ?? ""),
  );
}

export async function deleteMine(ctx: Ctx, viewerId: string, id: string) {
  return repo.deleteMyManual(ctx.env.DB, viewerId, id);
}

// ---- くり返し ----

export type RuleDto = {
  id: string;
  weekday: number;
  start: string;
  end: string;
  label: Label | null;
  timezone: string;
  exceptions: string[];
  createdAt: string;
};

export type CreateRuleResult = { kind: "created"; rule: RuleDto } | { kind: "invalid" } | { kind: "conflict" };

export async function createRule(ctx: Ctx, viewerId: string, input: CreateRecurrenceRuleRequest): Promise<CreateRuleResult> {
  const now = ctx.deps.now();
  let start: number | null;
  let end: number | null;
  let label: PresetName | null = null;
  if ("preset" in input) {
    const preset = (await getPresets(ctx, viewerId))[input.preset];
    start = parseHhmm(preset.start);
    end = parseHhmm(preset.end);
    label = input.preset;
  } else {
    start = parseHhmm(input.start);
    end = parseHhmm(input.end);
  }
  if (start === null || end === null || !checkLocalRange(start, end)) return { kind: "invalid" };
  const timezone = await getUserTimezone(ctx.env, viewerId);
  const id = crypto.randomUUID();
  const inserted = await repo.insertRuleWithinLimits(
    ctx.env.DB,
    {
      id,
      userId: viewerId,
      weekday: input.weekday,
      start_minute: start,
      end_minute: end,
      label,
      timezone,
      created_at: now,
    },
    MAX_RULES,
  );
  if (!inserted) return { kind: "conflict" };
  return {
    kind: "created",
    rule: {
      id,
      weekday: input.weekday,
      start: formatHhmm(start),
      end: formatHhmm(end),
      label,
      timezone,
      exceptions: [],
      createdAt: iso(now),
    },
  };
}

export async function listRules(ctx: Ctx, viewerId: string): Promise<RuleDto[]> {
  const rows = await repo.listMyRules(ctx.env.DB, viewerId);
  const now = ctx.deps.now();
  // 今日以降の外した日（ルールごとのタイムゾーンで今日を決める）
  const exceptions = await repo.exceptionsFor(
    ctx.env.DB,
    rows.map((r) => r.id),
    addDays(localDateOf(now, "UTC"), -1),
  );
  return rows.map((r) => {
    const today = localDateOf(now, r.timezone);
    return {
      id: r.id,
      weekday: r.weekday,
      start: formatHhmm(r.start_minute),
      end: formatHhmm(r.end_minute),
      label: asLabel(r.label),
      timezone: r.timezone,
      exceptions: (exceptions.get(r.id) ?? []).filter((d) => d >= today),
      createdAt: iso(r.created_at),
    };
  });
}

export async function deleteRule(ctx: Ctx, viewerId: string, id: string) {
  return repo.deleteMyRule(ctx.env.DB, viewerId, id);
}

export type ExceptionResult = "ok" | "not_found" | "invalid";

/** その日だけ外す・戻す。日付はルールの曜日に一致し、ルールのタイムゾーンで今日以降、60日以内 */
export async function setException(
  ctx: Ctx,
  viewerId: string,
  ruleId: string,
  date: string,
  skip: boolean,
): Promise<ExceptionResult> {
  const rule = await repo.findMyRule(ctx.env.DB, viewerId, ruleId);
  if (!rule) return "not_found";
  if (!skip) {
    await repo.removeException(ctx.env.DB, ruleId, date);
    return "ok";
  }
  if (!isValidDate(date)) return "invalid";
  const now = ctx.deps.now();
  const today = localDateOf(now, rule.timezone);
  const last = addDays(today, HORIZON_MS / DAY_MS);
  if (weekdayOf(date) !== rule.weekday || date < today || date > last) return "invalid";
  await repo.addException(ctx.env.DB, ruleId, date, now);
  return "ok";
}

// ---- 友達のここ暇 ----

type Range = { from: number; to: number };

/** 閲覧者に見せてよい相手の枠を、相手ごとに集める（手動＋くり返しの展開。まとめる前） */
async function collectVisible(ctx: Ctx, viewerId: string, range: Range, friendId?: string) {
  const now = ctx.deps.now();
  const [manual, ruleRows] = await Promise.all([
    repo.visibleManual(ctx.env.DB, viewerId, { ...range, now }, friendId),
    repo.visibleRules(ctx.env.DB, viewerId, friendId),
  ]);
  const rules = await rulesWithExceptions(ctx, ruleRows, exceptionSince(range.from));
  const byFriend = new Map<string, Slot[]>();
  const push = (owner: string, slot: Slot) => {
    const slots = byFriend.get(owner) ?? [];
    slots.push(slot);
    byFriend.set(owner, slots);
  };
  for (const m of manual) push(m.user_id, { startsAt: m.starts_at, endsAt: m.ends_at, label: asLabel(m.label) });
  ruleRows.forEach((row, i) => {
    const rule = rules[i];
    if (!rule) return;
    for (const e of expandRule(rule, range.from, range.to, now)) {
      push(row.user_id, { startsAt: e.startsAt, endsAt: e.endsAt, label: e.label });
    }
  });
  return byFriend;
}

export const FRIEND_PAGE_SIZE = 500;

/**
 * 「みんな」。処理の順番（仕様書）：3条件で全部取る → 展開 → 友達ごとにまとめる → 並べる → カーソルの後ろから500件
 */
export async function friendAvailabilities(ctx: Ctx, viewerId: string, range: Range, cursor: Cursor | null) {
  const [byFriend, mine] = await Promise.all([
    collectVisible(ctx, viewerId, range),
    listMine(ctx, viewerId, range.from - DAY_MS, range.to + DAY_MS),
  ]);
  const sorted = buildFriendSlots(byFriend, mine);
  const page = pageAfter(sorted, cursor, FRIEND_PAGE_SIZE);
  // 3条件で絞った結果のIDだけを渡す（T-02の制約）
  const profiles = await getPublicProfiles(ctx.env, [...new Set(page.items.map((s) => s.friendId))]);
  return {
    items: page.items.flatMap((s) => {
      const friend = profiles.get(s.friendId);
      if (!friend) return [];
      return [
        { friend, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), label: s.label, overlapsMine: s.overlapsMine },
      ];
    }),
    next: page.next,
  };
}

/**
 * 閲覧者に見えている、友達ひとりの枠（まとめた後）。友達の詳細と、T-04の誘いの種類の判定に使う。
 * 「見せない」にされていれば空。友達でない（片方向を含む）なら null
 */
export async function visibleSlotsFor(ctx: Ctx, viewerId: string, friendId: string, range: Range) {
  if (!(await repo.isMutualFriend(ctx.env.DB, viewerId, friendId))) return null;
  const byFriend = await collectVisible(ctx, viewerId, range, friendId);
  return mergeSlots(byFriend.get(friendId) ?? []);
}
