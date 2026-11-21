import { presetsSchema, type PresetName, type Presets } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { inputClass } from "../ui/form";
import { asEnd, PRESET_LABELS, PRESET_NAMES } from "./format";

/** 時間帯プリセットの境界の変更（設定の「時間帯プリセット」で使う） */
export function PresetForm({ initial }: { initial: Presets }) {
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
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {PRESET_NAMES.map((name) => (
        <fieldset key={name} className="flex items-center gap-2 border-b border-line pb-3">
          <legend className="sr-only">{PRESET_LABELS[name]}</legend>
          <span className="w-12 font-bold">{PRESET_LABELS[name]}</span>
          <input
            type="time"
            step={900}
            className={inputClass}
            aria-label={`${PRESET_LABELS[name]}の開始`}
            value={value[name].start}
            onChange={(e) => set(name, "start", e.target.value)}
          />
          〜
          <input
            type="time"
            step={900}
            className={inputClass}
            aria-label={`${PRESET_LABELS[name]}の終了`}
            value={value[name].end === "24:00" ? "00:00" : value[name].end}
            onChange={(e) => set(name, "end", e.target.value)}
          />
        </fieldset>
      ))}
      <Note>変えても、すでにあるここ暇とくり返しの時刻は変わりません。</Note>
      <SendButton type="submit" variant="primary" block disabled={save.isPending}>
        時間帯を保存
      </SendButton>
      {save.isError && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。15分単位で、30分以上、日をまたがない時間を選んでください。
        </p>
      )}
      {save.isSuccess && <p role="status" className="text-s text-ink-muted">保存しました</p>}
    </form>
  );
}
