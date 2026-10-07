import {
  myAvailabilitySchema,
  presetsSchema,
  recurrenceRuleSchema,
  type MyAvailability,
  type PresetName,
  type Presets,
  type RecurrenceRuleDto,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import {
  addDays,
  formatDate,
  formatSlot,
  localDateOf,
  localInstant,
  PRESET_LABELS,
  PRESET_NAMES,
  WEEKDAYS,
} from "../availability/format";
import { mineQuery, presetsQuery, rulesQuery, today } from "../availability/queries";
import { Nav } from "../components/Nav";

// ここ暇タブ（仮。docs/specs/T-03-availability.md「画面」）

type MyList = { items: MyAvailability[]; nextCursor: null };

const HORIZON_DAYS = 60;

function createErrorText(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return "作れませんでした。自分のほかのここ暇と重なっているか、作れる数の上限です。";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "作れませんでした。過去・60日より先・15分単位でない・30分未満の時間は選べません。";
  }
  return "作れませんでした。通信状態を確認して、もう一度お試しください。";
}

/** 時刻の入力の "00:00" を終了に使うときは 24:00 とみなす */
const asEnd = (hhmm: string) => (hhmm === "00:00" ? "24:00" : hhmm);

function AddAvailability({ presets }: { presets: Presets | undefined }) {
  const queryClient = useQueryClient();
  const first = today();
  const [date, setDate] = useState(first);
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("23:00");

  const create = useMutation({
    mutationFn: (body: unknown) => apiSend("POST", "/api/v1/availabilities", body, myAvailabilitySchema),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.availability.all() }),
  });

  const submitRange = () => {
    const startsAt = localInstant(date, start);
    // 終了が開始以前なら翌日の時刻（例：22:00〜02:00）
    let endsAt = localInstant(date, end);
    if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
    create.mutate({ startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">ここ暇を追加</h2>
      <label className="flex flex-col gap-1">
        日付
        <input
          type="date"
          className="rounded border px-2 py-1"
          value={date}
          min={first}
          max={addDays(first, HORIZON_DAYS)}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        {PRESET_NAMES.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={create.isPending || date === ""}
            className="flex-1 rounded-lg bg-amber-300 px-4 py-3 disabled:opacity-50"
            onClick={() => create.mutate({ date, preset })}
          >
            {PRESET_LABELS[preset]}
          </button>
        ))}
      </div>
      {presets && (
        <p className="text-sm text-slate-600">
          {PRESET_NAMES.map((p) => `${PRESET_LABELS[p]} ${presets[p].start}〜${presets[p].end}`).join("・")}
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitRange();
        }}
      >
        <label className="flex flex-col gap-1">
          開始
          <input type="time" step={900} className="rounded border px-2 py-1" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          終了
          <input type="time" step={900} className="rounded border px-2 py-1" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button type="submit" disabled={create.isPending || date === ""} className="rounded border px-3 py-1">
          時間を指定して追加
        </button>
      </form>
      {create.isError && (
        <p role="status" className="text-sm text-slate-600">
          {createErrorText(create.error)}
        </p>
      )}
    </section>
  );
}

const itemKey = (i: Pick<MyAvailability, "source" | "id" | "date">) => `${i.source}|${i.id}|${i.date ?? ""}`;

function MyAvailabilities() {
  const queryClient = useQueryClient();
  const date = today();
  const mine = useQuery(mineQuery(date));
  const [failed, setFailed] = useState(false);

  // 手動は取り消す、くり返しはこの日だけ外す。どちらも楽観的更新（押したらすぐ消し、失敗したら戻す）
  const remove = useMutation({
    mutationFn: (item: MyAvailability) =>
      item.source === "manual"
        ? apiSend("DELETE", `/api/v1/availabilities/${item.id}`, undefined)
        : apiSend("POST", `/api/v1/recurrence-rules/${item.id}/exceptions`, { date: item.date }),
    onMutate: async (item) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.availability.mine(date) });
      const previous = queryClient.getQueryData<MyList>(keys.availability.mine(date));
      queryClient.setQueryData<MyList>(keys.availability.mine(date), (list) =>
        list && { ...list, items: list.items.filter((i) => itemKey(i) !== itemKey(item)) },
      );
      return { previous };
    },
    onError: (_err, _item, context) => {
      if (context?.previous) queryClient.setQueryData(keys.availability.mine(date), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.availability.all() }),
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">自分のここ暇（14日分）</h2>
      {failed && (
        <p role="status" className="text-sm text-slate-600">
          変更できませんでした。もう一度お試しください。
        </p>
      )}
      {mine.data?.items.length === 0 && <p className="text-slate-600">まだここ暇はありません</p>}
      <ul aria-label="自分のここ暇" className="flex flex-col gap-2">
        {mine.data?.items.map((item) => (
          <li key={itemKey(item)} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-3">
            <span>
              {formatDate(localDateOf(item.startsAt))} {formatSlot(item)}
              {item.source === "recurrence" && <span className="ml-1 text-sm text-slate-500">（くり返し）</span>}
            </span>
            <button type="button" className="text-sm text-slate-600 underline" onClick={() => remove.mutate(item)}>
              {item.source === "manual" ? "取り消す" : "この日だけ外す"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ruleText(rule: RecurrenceRuleDto) {
  const time = `${rule.start}〜${rule.end}`;
  return `毎週${WEEKDAYS[rule.weekday]}曜 ${rule.label ? `${PRESET_LABELS[rule.label]} ${time}` : time}`;
}

function Recurrence() {
  const queryClient = useQueryClient();
  const rules = useQuery(rulesQuery());
  const [weekday, setWeekday] = useState(6);
  const [mode, setMode] = useState<PresetName | "custom">("night");
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("23:00");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.availability.all() });

  const create = useMutation({
    mutationFn: () =>
      apiSend(
        "POST",
        "/api/v1/recurrence-rules",
        mode === "custom" ? { weekday, start, end: asEnd(end) } : { weekday, preset: mode },
        recurrenceRuleSchema,
      ),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/api/v1/recurrence-rules/${id}`, undefined),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      apiSend("DELETE", `/api/v1/recurrence-rules/${id}/exceptions/${date}`, undefined),
    onSuccess: invalidate,
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">くり返し</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label className="flex flex-col gap-1">
          曜日
          <select aria-label="曜日" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i}>
                {w}曜
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          時間帯
          <select aria-label="時間帯" value={mode} onChange={(e) => setMode(e.target.value as PresetName | "custom")}>
            {PRESET_NAMES.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
            <option value="custom">時刻を指定</option>
          </select>
        </label>
        {mode === "custom" && (
          <>
            <label className="flex flex-col gap-1">
              開始
              <input type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1">
              終了
              <input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </>
        )}
        <button type="submit" disabled={create.isPending} className="rounded border px-3 py-1">
          くり返しを追加
        </button>
      </form>
      {create.isError && (
        <p role="status" className="text-sm text-slate-600">
          {create.error instanceof ApiError && create.error.status === 409
            ? "作れませんでした。同じ曜日のくり返しと重なっているか、作れる数（20個）の上限です。"
            : "作れませんでした。15分単位で、30分以上、日をまたがない時間を選んでください。"}
        </p>
      )}
      <ul aria-label="くり返し" className="flex flex-col gap-2">
        {rules.data?.items.map((rule) => (
          <li key={rule.id} className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <span>{ruleText(rule)}</span>
              <button type="button" className="text-sm text-slate-600 underline" onClick={() => remove.mutate(rule.id)}>
                削除
              </button>
            </div>
            {rule.exceptions.map((date) => (
              <div key={date} className="flex items-center justify-between text-sm text-slate-600">
                <span>{formatDate(date)}は外しています</span>
                <button type="button" className="underline" onClick={() => restore.mutate({ id: rule.id, date })}>
                  戻す
                </button>
              </div>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PresetForm({ initial }: { initial: Presets }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(initial);
  const save = useMutation({
    mutationFn: () => apiSend("PUT", "/api/v1/me/presets", value, presetsSchema),
    onSuccess: (presets) => queryClient.setQueryData(keys.availability.presets(), presets),
  });
  const set = (name: PresetName, field: "start" | "end", hhmm: string) =>
    setValue((v) => ({ ...v, [name]: { ...v[name], [field]: field === "end" ? asEnd(hhmm) : hhmm } }));

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {PRESET_NAMES.map((name) => (
        <fieldset key={name} className="flex items-center gap-2">
          <legend className="sr-only">{PRESET_LABELS[name]}</legend>
          <span className="w-10">{PRESET_LABELS[name]}</span>
          <input
            type="time"
            step={900}
            aria-label={`${PRESET_LABELS[name]}の開始`}
            value={value[name].start}
            onChange={(e) => set(name, "start", e.target.value)}
          />
          〜
          <input
            type="time"
            step={900}
            aria-label={`${PRESET_LABELS[name]}の終了`}
            value={value[name].end === "24:00" ? "00:00" : value[name].end}
            onChange={(e) => set(name, "end", e.target.value)}
          />
        </fieldset>
      ))}
      <p className="text-sm text-slate-600">変えても、すでにあるここ暇とくり返しの時刻は変わりません。</p>
      <button type="submit" disabled={save.isPending} className="self-start rounded border px-3 py-1">
        時間帯を保存
      </button>
      {save.isError && (
        <p role="status" className="text-sm text-slate-600">
          保存できませんでした。15分単位で、30分以上、日をまたがない時間を選んでください。
        </p>
      )}
      {save.isSuccess && <p className="text-sm text-slate-600">保存しました</p>}
    </form>
  );
}

export function AvailabilityPage() {
  const presets = useQuery(presetsQuery());
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">ここ暇</h1>
      <Nav />
      <AddAvailability presets={presets.data} />
      <MyAvailabilities />
      <Recurrence />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">時間帯</h2>
        {presets.data && <PresetForm initial={presets.data} />}
      </section>
    </main>
  );
}
