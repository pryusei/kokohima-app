import { DEFAULT_PRESETS, myAvailabilitySchema, type MyAvailability, type PresetName, type Presets } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { connectionsQuery, freeSlotsQuery } from "../calendar/queries";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { LoadError, Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { useOnline } from "../ui/online";
import { UndoToast, type ToastMessage } from "../ui/UndoToast";
import { formatDate, localDateOf, PRESET_LABELS, PRESET_NAMES, WEEKDAYS } from "./format";
import { mineQuery, presetsQuery, rulesQuery, today as todayOf } from "./queries";
import { RecurrenceSheet, ruleSummary } from "./RecurrenceSheet";
import { createErrorText, TimeRangeSheet } from "./TimeRangeSheet";
import {
  cellKey,
  cellName,
  cellOf,
  cellState,
  cellText,
  draftItem,
  freeCells,
  isPast,
  itemKey,
  itemsByCell,
  itemTime,
  restoreBody,
  WEEK_COUNT,
  weekDates,
  weekRangeText,
  type Cell,
  type CellState,
} from "./week";

// ここ暇タブの週の帯（docs/specs/T-55-availability-week-grid.md「画面」。協議のモックの案A）
// 7日×昼・夕方・夜のマス。押すとすぐ作る・取り消す・この日だけ外す（確認なし）。下に数秒「取り消す」を出す。
// カレンダーと連携していれば、空いているマスに青緑の点（T-06 の空きの候補。予定の中身は出さない）

type MyList = { items: MyAvailability[]; nextCursor: null };

/** 1回の操作。undo は「取り消す」で戻す操作（戻す操作には、さらに「取り消す」を出さない） */
type Change =
  | { kind: "create"; cell: Cell }
  | { kind: "cancel"; cell: Cell; item: MyAvailability; undo?: boolean }
  | { kind: "except"; cell: Cell; item: MyAvailability }
  | { kind: "restore"; cell: Cell; item: MyAvailability }
  | { kind: "unexcept"; cell: Cell; item: MyAvailability };

const FAILED_TEXT = "変更できませんでした。もう一度お試しください。";

const cellLabel = (cell: Cell) => `${formatDate(cell.date)} ${PRESET_LABELS[cell.preset]}`;

function useWeekChanges(date: string, presets: Presets, showToast: (m: Omit<ToastMessage, "id">) => void) {
  const queryClient = useQueryClient();
  const mineKey = keys.availability.mine(date);
  const idempotency = useIdempotencyKey();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const mark = (cell: Cell, on: boolean) =>
    setPending((prev) => {
      const next = new Set(prev);
      if (on) next.add(cellKey(cell.date, cell.preset));
      else next.delete(cellKey(cell.date, cell.preset));
      return next;
    });

  const post = (body: unknown) => {
    const path = "/api/v1/availabilities";
    return apiSend("POST", path, body, myAvailabilitySchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
  };

  const change = useMutation({
    mutationFn: async (c: Change): Promise<MyAvailability | undefined> => {
      switch (c.kind) {
        case "create":
          return post({ date: c.cell.date, preset: c.cell.preset });
        case "restore":
          return post(restoreBody(c.item, presets));
        case "cancel":
          await apiSend("DELETE", `/api/v1/availabilities/${c.item.id}`, undefined);
          return undefined;
        case "except":
          await apiSend("POST", `/api/v1/recurrence-rules/${c.item.id}/exceptions`, { date: c.item.date });
          return undefined;
        case "unexcept":
          await apiSend("DELETE", `/api/v1/recurrence-rules/${c.item.id}/exceptions/${c.item.date}`, undefined);
          return undefined;
      }
    },
    // 楽観的更新（data-fetching スキル）：押したらすぐ変え、失敗したら戻す
    onMutate: async (c) => {
      mark(c.cell, true);
      await queryClient.cancelQueries({ queryKey: mineKey });
      const previous = queryClient.getQueryData<MyList>(mineKey);
      const added = c.kind === "create" ? draftItem(presets, c.cell) : c.kind === "restore" || c.kind === "unexcept" ? c.item : null;
      queryClient.setQueryData<MyList>(mineKey, (list) => {
        if (!list) return list;
        if (added) return { ...list, items: [...list.items, added] };
        if (c.kind === "create") return list;
        return { ...list, items: list.items.filter((i) => itemKey(i) !== itemKey(c.item)) };
      });
      setLastCreated(c.kind === "create" ? cellKey(c.cell.date, c.cell.preset) : null);
      return { previous, added };
    },
    onError: (error, c, context) => {
      if (context?.previous) queryClient.setQueryData(mineKey, context.previous);
      showToast({ text: c.kind === "create" || c.kind === "restore" ? createErrorText(error) : FAILED_TEXT });
    },
    onSuccess: (result, c, context) => {
      // 仮の枠を、応答の本物（id つき）に置き換える。読み直しが終わる前に押されても、正しい id で送れるように
      if (result && context?.added) {
        const replaced = itemKey(context.added);
        queryClient.setQueryData<MyList>(mineKey, (list) => list && { ...list, items: list.items.map((i) => (itemKey(i) === replaced ? result : i)) });
      }
      const label = cellLabel(c.cell);
      switch (c.kind) {
        case "create":
          if (result) showToast({ text: `${label}をここ暇にしました`, undo: () => change.mutate({ kind: "cancel", cell: c.cell, item: result, undo: true }) });
          return;
        case "cancel":
          if (c.undo) showToast({ text: "元に戻しました" });
          else showToast({ text: `${label}のここ暇を取り消しました`, undo: () => change.mutate({ kind: "restore", cell: c.cell, item: c.item }) });
          return;
        case "except":
          showToast({ text: `${label}だけ外しました（毎週はそのまま）`, undo: () => change.mutate({ kind: "unexcept", cell: c.cell, item: c.item }) });
          return;
        case "restore":
        case "unexcept":
          showToast({ text: "元に戻しました" });
          return;
      }
    },
    onSettled: (_data, error, c) => {
      if (c.kind === "create" || c.kind === "restore") idempotency.settle(error);
      mark(c.cell, false);
      void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
    },
  });

  return { change, pending, lastCreated };
}

function Legend({ calendar }: { calendar: boolean }) {
  const swatch = "inline-block size-3 rounded-s border border-lamp-line bg-lamp-soft align-[-2px]";
  // 見た目の手がかり。読み上げでは各マスの名前に状態を入れているので、ここは読ませない
  return (
    <p aria-hidden="true" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
      <span className="flex items-center gap-1">
        <span className={swatch} />
        ここ暇
      </span>
      <span className="flex items-center gap-1">
        <span className={`${swatch} border-dashed`} />
        くり返し
      </span>
      {calendar && (
        <span className="flex items-center gap-1">
          <span className="inline-block size-1.5 rounded-full bg-meet" />
          カレンダーで空き
        </span>
      )}
    </p>
  );
}

const CELL_LOOK: Record<CellState["kind"], string> = {
  empty: "border-line bg-surface text-ink",
  past: "border-transparent bg-surface-sunken text-ink-disabled",
  one: "border-lamp-line bg-lamp-soft font-bold text-ink",
  many: "border-lamp-line bg-lamp-soft font-bold text-ink",
};

function CellButton({
  cell,
  state,
  presets,
  busy,
  ready,
  pop,
  onPress,
}: {
  cell: Cell;
  state: CellState;
  presets: Presets;
  busy: boolean;
  ready: boolean;
  pop: boolean;
  onPress: () => void;
}) {
  const online = useOnline();
  const recurring =
    (state.kind === "one" && state.item.source === "recurrence") || (state.kind === "many" && state.items.every((i) => i.source === "recurrence"));
  const on = state.kind === "one" || state.kind === "many";
  // 過ぎた空きのマスと、読み込み前・オフラインのマスは押せない。送っている間のマスは、フォーカスを失わないよう aria-disabled にする
  const disabled = state.kind === "past" || !ready || !online;
  return (
    <button
      type="button"
      aria-label={cellName(cell, state, presets)}
      aria-pressed={state.kind === "past" ? undefined : on}
      aria-disabled={busy || undefined}
      disabled={disabled}
      onClick={() => {
        if (!busy) onPress();
      }}
      className={`relative grid h-12 w-full place-items-center rounded-m border text-xs tabular-nums ${CELL_LOOK[state.kind]} ${
        recurring ? "border-dashed" : ""
      } ${pop && on ? "motion-safe:animate-[kh-pop_.35s_ease-out]" : ""}`}
    >
      <span aria-hidden="true">{cellText(cell, state)}</span>
      {state.kind === "empty" && state.free && <span aria-hidden="true" className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-meet" />}
    </button>
  );
}

/** マスに2つ以上のここ暇があるとき、1つずつ選んで取り消す・外すシート */
function CellSheet({ cell, items, onChange, onClose }: { cell: Cell; items: MyAvailability[]; onChange: (c: Change) => void; onClose: () => void }) {
  return (
    <BottomSheet title={cellLabel(cell)} label={cellLabel(cell)} onClose={onClose}>
      <ul aria-label="このマスのここ暇" className="rounded-l border border-line px-4">
        {items.map((item) => (
          <li key={itemKey(item)} className="flex items-center justify-between gap-2 border-b border-line py-3 last:border-b-0">
            <span className="tabular-nums">
              {itemTime(item)}
              {item.source === "recurrence" && <span className="ml-2 text-xs text-ink-muted">くり返し</span>}
            </span>
            <SendButton
              variant="ghost"
              size="s"
              onClick={() => onChange(item.source === "manual" ? { kind: "cancel", cell, item } : { kind: "except", cell, item })}
            >
              {item.source === "manual" ? "取り消す" : "この日だけ外す"}
            </SendButton>
          </li>
        ))}
      </ul>
    </BottomSheet>
  );
}

function WeekGrid({
  dates,
  today,
  now,
  presets,
  cells,
  free,
  ready,
  pending,
  lastCreated,
  onPress,
}: {
  dates: string[];
  today: string;
  now: number;
  presets: Presets;
  cells: Map<string, MyAvailability[]>;
  free: Set<string>;
  ready: boolean;
  pending: ReadonlySet<string>;
  lastCreated: string | null;
  onPress: (cell: Cell, state: CellState) => void;
}) {
  return (
    // マスの間は4px。表の外側の隙間を負の余白で打ち消して、左右の端を中身の幅にそろえる
    <table className="-mx-1 w-[calc(100%+0.5rem)] table-fixed border-separate border-spacing-1">
      <caption className="sr-only">ここ暇の週の帯。押すとここ暇になります</caption>
      <thead>
        <tr>
          <th scope="col" className="w-10">
            <span className="sr-only">時間帯</span>
          </th>
          {dates.map((date) => {
            const isToday = date === today;
            const day = Number(date.slice(8, 10));
            const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
            return (
              <th key={date} scope="col" className="pb-0.5 text-center text-xs font-normal text-ink-muted">
                <span className="sr-only">{isToday ? `今日 ${formatDate(date)}` : formatDate(date)}</span>
                <span aria-hidden="true" className="flex flex-col items-center leading-tight">
                  {isToday ? "今日" : weekday}
                  <span
                    className={`mt-0.5 grid h-6 min-w-6 place-items-center rounded-full px-1 text-m font-bold tabular-nums ${
                      isToday ? "bg-ink text-surface" : "text-ink"
                    }`}
                  >
                    {day}
                  </span>
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {PRESET_NAMES.map((preset: PresetName) => (
          <tr key={preset}>
            <th scope="row" className="text-left text-xxs font-normal text-ink-muted">
              <span className="block text-s font-bold text-ink">{PRESET_LABELS[preset]}</span>
              <span aria-hidden="true" className="tabular-nums">
                {presets[preset].start}
              </span>
              <span className="sr-only">
                {presets[preset].start}〜{presets[preset].end}
              </span>
            </th>
            {dates.map((date) => {
              const cell = { date, preset };
              const key = cellKey(date, preset);
              const state = cellState(cells.get(key), free.has(key), isPast(presets, cell, now));
              return (
                <td key={key} className="p-0">
                  <CellButton
                    cell={cell}
                    state={state}
                    presets={presets}
                    busy={pending.has(key)}
                    ready={ready}
                    pop={lastCreated === key}
                    onPress={() => onPress(cell, state)}
                  />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 1行のリンク（押すとシートを開く） */
function RowLink({ children, aside, onClick }: { children: ReactNode; aside: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center justify-between gap-2 rounded-l bg-surface px-4 py-2 text-left shadow-card"
    >
      <span className="min-w-0">{children}</span>
      <span className="shrink-0 text-s text-ink-muted">{aside} ›</span>
    </button>
  );
}

/** カレンダーの空き（T-06）。連携していて読めたときだけ点を出す。予定の中身は受け取らない */
function useCalendarFree(date: string) {
  const connections = useQuery(connectionsQuery());
  const status = connections.data?.google.status;
  const slots = useQuery({ ...freeSlotsQuery(date), enabled: status === "connected" });
  const reauth = status === "needs_reauth" || slots.data?.status === "needs_reauth";
  const unavailable = slots.data?.status === "unavailable";
  // 回数の上限（429。T-10）は、点を出さずに静かに待ってもらう（取り直さない。freeSlotsQuery の retry）
  const rateLimited = slots.error instanceof ApiError && slots.error.status === 429;
  return {
    rateLimited,
    connected: status === "connected" && !reauth,
    free: freeCells(slots.data?.status === "ok" ? slots.data.items : []),
    reauth,
    unavailable,
  };
}

/** 今の時刻。1分ごとに進め、過ぎた時間帯のマスを押せなくする */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type Open = { kind: "time" } | { kind: "rule" } | { kind: "cell"; cell: Cell } | null;

export function WeekPlanner() {
  // 日付は開いたときに決める（日をまたいで開いたままでも、読み込みのキーがずれないように）
  const [today] = useState(todayOf);
  const now = useNow();
  const [week, setWeek] = useState(0);
  const [open, setOpen] = useState<Open>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastId = useRef(0);
  const showToast = useCallback((m: Omit<ToastMessage, "id">) => setToast({ ...m, id: ++toastId.current }), []);
  const hideToast = useCallback(() => setToast(null), []);

  const presetsData = useQuery(presetsQuery()).data;
  const presets = presetsData ?? DEFAULT_PRESETS;
  const mine = useQuery(mineQuery(today));
  const rules = useQuery(rulesQuery());
  const calendar = useCalendarFree(today);
  const { change, pending, lastCreated } = useWeekChanges(today, presets, showToast);

  const dates = weekDates(today, week);
  const cells = itemsByCell(mine.data?.items ?? [], presets, today);
  const ruleItems = rules.data?.items ?? [];

  const press = (cell: Cell, state: CellState) => {
    if (state.kind === "empty") change.mutate({ kind: "create", cell });
    else if (state.kind === "one") change.mutate(state.item.source === "manual" ? { kind: "cancel", cell, item: state.item } : { kind: "except", cell, item: state.item });
    else if (state.kind === "many") setOpen({ kind: "cell", cell });
  };
  const openCell = open?.kind === "cell" ? open.cell : null;
  const openCellItems = openCell ? cells.get(cellKey(openCell.date, openCell.preset)) ?? [] : [];

  return (
    <section aria-labelledby="week-title" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="week-title" className="text-m font-bold tabular-nums">
          <span className="sr-only">自分のここ暇</span> {weekRangeText(dates)}
        </h2>
        <div className="flex">
          <Button variant="ghost" aria-label="前の7日" disabled={week === 0} onClick={() => setWeek((w) => w - 1)}>
            ‹
          </Button>
          <Button variant="ghost" disabled={week === WEEK_COUNT - 1} onClick={() => setWeek((w) => w + 1)}>
            次の7日 ›
          </Button>
        </div>
      </div>
      {mine.isError && <LoadError retry={() => void mine.refetch()} />}
      <WeekGrid
        dates={dates}
        today={today}
        now={now}
        presets={presets}
        cells={cells}
        free={calendar.free}
        ready={mine.isSuccess}
        pending={pending}
        lastCreated={lastCreated}
        onPress={press}
      />
      <Legend calendar={calendar.connected} />
      {calendar.reauth && (
        <Note>
          カレンダーの連携が切れています。
          <Link to="/settings/calendar" className="text-action underline">
            設定
          </Link>
          からもう一度連携すると、空いている時間に点が付きます
        </Note>
      )}
      {calendar.unavailable && <Note>カレンダーを読み込めませんでした</Note>}
      {calendar.rateLimited && <Note>カレンダーの空きは、少し待ってからもう一度開くと出ます</Note>}
      <div className="mt-2 flex flex-col gap-2">
        <RowLink aside="開始・終了" onClick={() => setOpen({ kind: "time" })}>
          時間を細かく決めて入れる
        </RowLink>
        <RowLink aside={ruleItems.length > 0 ? `${ruleItems.length}つ` : "なし"} onClick={() => setOpen({ kind: "rule" })}>
          くり返し
          {ruleItems[0] && <span className="ml-3 font-bold">{ruleSummary(ruleItems[0])}</span>}
        </RowLink>
      </div>
      {open?.kind === "time" && (
        <TimeRangeSheet
          onClose={() => setOpen(null)}
          onCreated={(item) =>
            showToast({
              text: `${formatDate(localDateOf(item.startsAt))} ${itemTime(item)}を入れました`,
              undo: () => change.mutate({ kind: "cancel", cell: cellOf(item, presets, today), item, undo: true }),
            })
          }
        />
      )}
      {open?.kind === "rule" && <RecurrenceSheet onClose={() => setOpen(null)} />}
      {openCell && openCellItems.length > 0 && (
        <CellSheet
          cell={openCell}
          items={openCellItems}
          onChange={(c) => change.mutate(c)}
          onClose={() => setOpen(null)}
        />
      )}
      <UndoToast message={toast} onDone={hideToast} />
    </section>
  );
}

