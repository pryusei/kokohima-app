import { recurrenceRuleSchema, type PresetName, type RecurrenceRuleDto } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { markCreatedRow, MotionRow, useRowExits } from "../ui/RowMotion";
import { Field, inputClass } from "../ui/form";
import { asEnd, formatDate, PRESET_LABELS, PRESET_NAMES, WEEKDAYS } from "./format";
import { rulesQuery } from "./queries";

// 「くり返し」のシート（docs/specs/T-55-availability-week-grid.md「振る舞い 4.」。中身は T-03 のくり返し）
// 一覧・削除・外した日を戻す と、追加のフォームを1つのシートの中で切り替える（シートを重ねない）

export function ruleText(rule: RecurrenceRuleDto) {
  const time = `${rule.start}〜${rule.end}`;
  return `毎週${WEEKDAYS[rule.weekday]}曜 ${rule.label ? `${PRESET_LABELS[rule.label]} ${time}` : time}`;
}

/** 1行のリンクに出す短い要約（「毎週金 昼」「毎週土 19:00〜」） */
export function ruleSummary(rule: RecurrenceRuleDto) {
  return `毎週${WEEKDAYS[rule.weekday]} ${rule.label ? PRESET_LABELS[rule.label] : `${rule.start}〜`}`;
}

function AddRecurrenceForm({ onDone }: { onDone: () => void }) {
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
    onSuccess: (rule) => {
      // 一覧に戻ったときに、増えた行を開いて一度だけ光らせる（docs/specs/T-56-motion.md「M-10」）
      if (rule) markCreatedRow(rule.id);
      void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      onDone();
    },
  });

  return (
    <>
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
      <Button variant="ghost" block onClick={onDone}>
        一覧に戻る
      </Button>
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          {isIdempotencyConflict(create.error)
            ? "作れませんでした。もう一度お試しください。"
            : create.error instanceof ApiError && create.error.status === 409
            ? "作れませんでした。同じ曜日のくり返しと重なっているか、作れる数（20個）の上限です。"
            : "作れませんでした。15分単位で、30分以上、日をまたがない時間を選んでください。"}
        </p>
      )}
    </>
  );
}

const NO_RULES: RecurrenceRuleDto[] = [];
const ruleKey = (rule: RecurrenceRuleDto) => rule.id;

function RuleList({ onAdd }: { onAdd: () => void }) {
  const queryClient = useQueryClient();
  const rules = useQuery(rulesQuery());
  const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.availability.all() });
  // 削除した行は閉じて消え、失敗したら元の場所に開いて戻る（docs/specs/T-56-motion.md「M-10」）
  const exits = useRowExits(rules.data?.items ?? NO_RULES, ruleKey);
  const { leave, restore: restoreRow } = exits;
  const remove = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/api/v1/recurrence-rules/${id}`, undefined),
    onMutate: (id) => leave(id),
    onError: (_error, id) => restoreRow(id),
    onSuccess: invalidate,
  });
  const restore = useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      apiSend("DELETE", `/api/v1/recurrence-rules/${id}/exceptions/${date}`, undefined),
    onSuccess: invalidate,
  });
  const failed = remove.isError || restore.isError;

  return (
    <>
      {rules.isPending && <Loading />}
      {rules.isError && <LoadError retry={() => void rules.refetch()} />}
      {rules.data?.items.length === 0 && <Note>まだくり返しはありません。毎週の決まった暇な時間を入れておけます。</Note>}
      {exits.rows.length > 0 && (
        <ul aria-label="くり返し" className="rounded-l border border-line px-4">
          {exits.rows.map((row) => (
            <MotionRow
              key={row.key}
              row={row}
              onHidden={exits.hidden}
              onAppeared={exits.appeared}
              inSheet
              className="flex flex-col gap-1 border-b border-line py-3 group-last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="tabular-nums">{ruleText(row.item)}</span>
                <SendButton variant="ghost" size="s" onClick={() => remove.mutate(row.item.id)}>
                  削除
                </SendButton>
              </div>
              {row.item.exceptions.map((date) => (
                <div key={date} className="flex items-center justify-between gap-2 text-s text-ink-muted">
                  <span>{formatDate(date)}は外しています</span>
                  <SendButton variant="ghost" size="s" onClick={() => restore.mutate({ id: row.item.id, date })}>
                    戻す
                  </SendButton>
                </div>
              ))}
            </MotionRow>
          ))}
        </ul>
      )}
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          変更できませんでした。もう一度お試しください。
        </p>
      )}
      <Button block onClick={onAdd}>
        ＋ くり返しを追加する
      </Button>
    </>
  );
}

export function RecurrenceSheet({ onClose }: { onClose: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <BottomSheet title={adding ? "くり返しを追加" : "くり返し"} label={adding ? "くり返しを追加" : "くり返し"} onClose={onClose}>
      {adding ? <AddRecurrenceForm onDone={() => setAdding(false)} /> : <RuleList onAdd={() => setAdding(true)} />}
    </BottomSheet>
  );
}
