import { meResponseSchema } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Field, inputClass } from "../ui/form";
import { SaveButton, useSaveState } from "../ui/SaveButton";

/** サーバーの displayNameSchema と同じ正規化（NFC と前後の空白） */
const normalize = (v: string) => v.normalize("NFC").trim();

/** 表示名の設定（名前の画面と、設定のアカウントで使う。docs/specs/T-31-display-name-first-step.md、T-54） */
export function DisplayNameForm({ initial = "", submitLabel = "保存する" }: { initial?: string; submitLabel?: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(initial);
  const [savedValue, setSavedValue] = useState(initial);
  const save = useMutation({
    mutationFn: (displayName: string) => apiSend("PATCH", "/api/v1/me", { displayName }, meResponseSchema),
    onSuccess: (me, sent) => {
      queryClient.setQueryData(keys.me(), me);
      setSavedValue(me?.displayName ?? normalize(sent));
      markSaved();
    },
  });
  // サーバーと同じく、前後の空白と正規化の違いは「変えた」に数えない。空白だけのあいだも押せない
  const name = normalize(value);
  const { state, markSaved } = useSaveState({ changed: name !== "" && name !== savedValue, pending: save.isPending });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(value);
      }}
    >
      <Field label="表示名">
        <input className={inputClass} value={value} maxLength={20} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <SaveButton state={state}>{submitLabel}</SaveButton>
      {save.isError && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。1〜20文字で入力してください。
        </p>
      )}
    </form>
  );
}
