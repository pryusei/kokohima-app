import { meResponseSchema } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { SendButton } from "../ui/Button";
import { Field, inputClass } from "../ui/form";

/** 表示名の設定（名前の画面と、設定のアカウントで使う。docs/specs/T-31-display-name-first-step.md） */
export function DisplayNameForm({ initial = "", submitLabel = "保存する" }: { initial?: string; submitLabel?: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(initial);
  const save = useMutation({
    mutationFn: () => apiSend("PATCH", "/api/v1/me", { displayName: value }, meResponseSchema),
    onSuccess: (me) => queryClient.setQueryData(keys.me(), me),
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="表示名">
        <input className={inputClass} value={value} maxLength={20} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <SendButton type="submit" variant="primary" disabled={save.isPending || value.trim() === ""}>
        {submitLabel}
      </SendButton>
      {save.isError && (
        <p role="status" className="text-s text-ink-muted">
          保存できませんでした。1〜20文字で入力してください。
        </p>
      )}
      {save.isSuccess && <p role="status" className="text-s text-ink-muted">保存しました</p>}
    </form>
  );
}
