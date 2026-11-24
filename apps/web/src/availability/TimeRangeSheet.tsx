import { myAvailabilitySchema, type MyAvailability } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { BottomSheet } from "../ui/BottomSheet";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { addDays, localInstant } from "./format";
import { today } from "./queries";

// 「時間を細かく決めて入れる」のシート（docs/specs/T-55-availability-week-grid.md「振る舞い 4.」。T-03 の開始・終了の指定）
// 昼・夕方・夜は週の帯で押す。ここでは日付・開始・終了を決めて作る。60日先まで選べる

const HORIZON_DAYS = 60;

export function createErrorText(error: unknown) {
  if (isIdempotencyConflict(error)) return "作れませんでした。もう一度お試しください。";
  if (error instanceof ApiError && error.status === 409) {
    return "作れませんでした。自分のほかのここ暇と重なっているか、作れる数の上限です。";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "作れませんでした。過去・60日より先・15分単位でない・30分未満の時間は選べません。";
  }
  return "作れませんでした。通信状態を確認して、もう一度お試しください。";
}

/** 成功したら閉じ、作った枠を onCreated に渡す（週の帯の「取り消す」に使う） */
export function TimeRangeSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (item: MyAvailability) => void }) {
  const queryClient = useQueryClient();
  const first = today();
  const [date, setDate] = useState(first);
  const [start, setStart] = useState("19:00");
  const [end, setEnd] = useState("23:00");

  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: (body: { startsAt: string; endsAt: string }) => {
      const path = "/api/v1/availabilities";
      return apiSend("POST", path, body, myAvailabilitySchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      if (item) onCreated(item);
      onClose();
    },
  });

  const submit = () => {
    const startsAt = localInstant(date, start);
    // 終了が開始以前なら翌日の時刻（例：22:00〜02:00）
    let endsAt = localInstant(date, end);
    if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
    create.mutate({ startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() });
  };

  return (
    <BottomSheet title="時間を決めて入れる" label="時間を決めて入れる" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
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
        <div className="flex items-end gap-2">
          <Field label="開始">
            <input type="time" step={900} className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <span className="pb-2.5">〜</span>
          <Field label="終了">
            <input type="time" step={900} className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Note>終了が開始より前なら、翌日の時刻になります（22:00〜翌02:00）。60日先まで入れられます。</Note>
        <SendButton type="submit" variant="lamp" block disabled={create.isPending || date === ""}>
          入れる
        </SendButton>
      </form>
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          {createErrorText(create.error)}
        </p>
      )}
    </BottomSheet>
  );
}
