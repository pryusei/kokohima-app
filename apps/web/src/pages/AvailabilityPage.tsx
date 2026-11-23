import {
  myAvailabilitySchema,
  recurrenceRuleSchema,
  type MyAvailability,
  type PresetName,
  type Presets,
  type RecurrenceRuleDto,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import {
  addDays,
  asEnd,
  formatDate,
  formatSlot,
  localDateOf,
  localInstant,
  PRESET_LABELS,
  PRESET_NAMES,
  WEEKDAYS,
} from "../availability/format";
import { mineQuery, presetsQuery, rulesQuery, today } from "../availability/queries";
import { CalendarCandidates } from "../calendar/CalendarCandidates";
import { AvailabilityChip } from "../ui/AvailabilityChip";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { Section, TabScreen } from "../ui/Navigation";
import { MyWishes } from "../wish/MyWishes";

// ここ暇タブ（docs/specs/T-03-availability.md「画面」、キャンバス「5 ここ暇」「8 ここ暇の追加」「9 くり返しの追加」）
// ここ暇の追加とくり返しの追加は、URL を持たないシートで開く（docs/specs/T-11-design.md「画面のつながり」）

type MyList = { items: MyAvailability[]; nextCursor: null };

const HORIZON_DAYS = 60;

function createErrorText(error: unknown) {
  if (isIdempotencyConflict(error)) return "作れませんでした。もう一度お試しください。";
  if (error instanceof ApiError && error.status === 409) {
    return "作れませんでした。自分のほかのここ暇と重なっているか、作れる数の上限です。";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "作れませんでした。過去・60日より先・15分単位でない・30分未満の時間は選べません。";
  }
  return "作れませんでした。通信状態を確認して、もう一度お試しください。";
}

function AddAvailabilitySheet({ presets, onClose }: { presets: Presets | undefined; onClose: () => void }) {
  const queryClient = useQueryClient();
  const first = today();
  const [date, setDate] = useState(first);
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("23:00");

  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: (body: unknown) => {
      const path = "/api/v1/availabilities";
      return apiSend("POST", path, body, myAvailabilitySchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
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
    <BottomSheet title="ここ暇を追加" label="ここ暇を追加" onClose={onClose}>
      <Field label="日付">
        <input
          type="date"
          className={inputClass}
          value={date}
          min={first}
          max={addDays(first, HORIZON_DAYS)}
          onChange={(e) => setDate(e.target.value)}
        />
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-bold text-ink-muted">押すとすぐ作ります</span>
        <div className="grid grid-cols-3 gap-2">
          {PRESET_NAMES.map((preset) => (
            <SendButton
              key={preset}
              disabled={create.isPending || date === ""}
              className="min-h-16 flex-col gap-0"
              onClick={() => create.mutate({ date, preset })}
            >
              {PRESET_LABELS[preset]}
              {presets && (
                <span className="text-s font-normal text-ink-muted tabular-nums">
                  {presets[preset].start}〜{presets[preset].end}
                </span>
              )}
            </SendButton>
          ))}
        </div>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submitRange();
        }}
      >
        <div className="flex items-end gap-2">
          <Field label="開始">
            <input type="time" step={900} className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <span className="pb-2.5">〜</span>
          <Field label="終了">
            <input type="time" step={900} className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Note>終了が開始より前なら、翌日の時刻になります（22:00〜翌02:00）</Note>
        <SendButton type="submit" variant="lamp" block disabled={create.isPending || date === ""}>
          時間を指定して追加
        </SendButton>
      </form>
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          {createErrorText(create.error)}
        </p>
      )}
      {create.isSuccess && <p role="status" className="text-s text-ink-muted">追加しました</p>}
    </BottomSheet>
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
    <Section title="自分のここ暇" aside="今日から14日">
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          変更できませんでした。もう一度お試しください。
        </p>
      )}
      {mine.isPending && <Loading />}
      {mine.isError && <LoadError retry={() => void mine.refetch()} />}
      {mine.data?.items.length === 0 && <EmptyState title="まだここ暇はありません" description="「ここ暇を追加」から、昼・夕方・夜を押すと作れます" />}
      {mine.data && mine.data.items.length > 0 && (
        <ul aria-label="自分のここ暇" className="rounded-l bg-surface px-4 shadow-card">
          {mine.data.items.map((item) => (
            <li key={itemKey(item)} className="flex items-center gap-2 border-b border-line py-3 last:border-b-0">
              <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
                <span className="font-bold tabular-nums">{formatDate(localDateOf(item.startsAt))}</span>
                <AvailabilityChip text={formatSlot(item)} recurring={item.source === "recurrence"} />
              </span>
              <SendButton variant="ghost" size="s" onClick={() => remove.mutate(item)}>
                {item.source === "manual" ? "取り消す" : "この日だけ外す"}
              </SendButton>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ruleText(rule: RecurrenceRuleDto) {
  const time = `${rule.start}〜${rule.end}`;
  return `毎週${WEEKDAYS[rule.weekday]}曜 ${rule.label ? `${PRESET_LABELS[rule.label]} ${time}` : time}`;
}

/** くり返しの追加のシート。フォームと送信の状態はシートが持つ（閉じて開き直すと、前回の入力やエラーは残らない）。成功したら閉じる */
function AddRecurrenceSheet({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [weekday, setWeekday] = useState(6);
  const [mode, setMode] = useState<PresetName | "custom">("night");
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("23:00");

  const ruleIdempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: () => {
      const path = "/api/v1/recurrence-rules";
      const body = mode === "custom" ? { weekday, start, end: asEnd(end) } : { weekday, preset: mode };
      return apiSend("POST", path, body, recurrenceRuleSchema, {
        idempotencyKey: ruleIdempotency.keyFor(signatureOf(path, body)),
      });
    },
    onSettled: (_data, error) => ruleIdempotency.settle(error),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      onClose();
    },
  });

  return (
    <BottomSheet title="くり返しを追加" label="くり返しを追加" onClose={onClose}>
      <Note>毎週の決まった暇な時間。特定の日だけ外すこともできます。</Note>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="曜日">
          <select aria-label="曜日" className={inputClass} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {WEEKDAYS.map((w, i) => (
              <option key={w} value={i}>
                {w}曜
              </option>
            ))}
          </select>
        </Field>
        <Field label="時間帯">
          <select aria-label="時間帯" className={inputClass} value={mode} onChange={(e) => setMode(e.target.value as PresetName | "custom")}>
            {PRESET_NAMES.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
            <option value="custom">時刻を指定</option>
          </select>
        </Field>
        {mode === "custom" && (
          <div className="flex items-end gap-2">
            <Field label="開始">
              <input type="time" step={900} className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <span className="pb-2.5">〜</span>
            <Field label="終了">
              <input type="time" step={900} className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
        )}
        <SendButton type="submit" variant="primary" block disabled={create.isPending}>
          くり返しを追加
        </SendButton>
      </form>
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          {isIdempotencyConflict(create.error)
            ? "作れませんでした。もう一度お試しください。"
            : create.error instanceof ApiError && create.error.status === 409
            ? "作れませんでした。同じ曜日のくり返しと重なっているか、作れる数（20個）の上限です。"
            : "作れませんでした。15分単位で、30分以上、日をまたがない時間を選んでください。"}
        </p>
      )}
    </BottomSheet>
  );
}

function Recurrence() {
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();
  const rules = useQuery(rulesQuery());
  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.availability.all() });
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
    <Section
      title="くり返し"
      aside={
        <Button variant="ghost" size="s" onClick={() => setAdding(true)}>
          くり返しを追加する
        </Button>
      }
    >
      {rules.data && rules.data.items.length > 0 && (
        <ul aria-label="くり返し" className="rounded-l bg-surface px-4 shadow-card">
          {rules.data.items.map((rule) => (
            <li key={rule.id} className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <span className="tabular-nums">{ruleText(rule)}</span>
                <SendButton variant="ghost" size="s" onClick={() => remove.mutate(rule.id)}>
                  削除
                </SendButton>
              </div>
              {rule.exceptions.map((date) => (
                <div key={date} className="flex items-center justify-between gap-2 text-s text-ink-muted">
                  <span>{formatDate(date)}は外しています</span>
                  <SendButton variant="ghost" size="s" onClick={() => restore.mutate({ id: rule.id, date })}>
                    戻す
                  </SendButton>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddRecurrenceSheet onClose={() => setAdding(false)} />}
    </Section>
  );
}

export function AvailabilityPage() {
  const presets = useQuery(presetsQuery());
  const [adding, setAdding] = useState(false);
  return (
    <TabScreen title="ここ暇">
      <Button variant="lamp" block onClick={() => setAdding(true)}>
        ここ暇を追加
      </Button>
      <CalendarCandidates />
      <MyAvailabilities />
      <Recurrence />
      <MyWishes />
      {adding && <AddAvailabilitySheet presets={presets.data} onClose={() => setAdding(false)} />}
    </TabScreen>
  );
}
