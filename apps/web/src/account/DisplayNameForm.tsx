import { meResponseSchema } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";

/** 表示名の設定（招待リンクを作る前と、設定のアカウントで使う） */
export function DisplayNameForm({ initial = "", intro }: { initial?: string; intro?: string }) {
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
      {intro && <Note>{intro}</Note>}
      <Field label="表示名">
        <input className={inputClass} value={value} maxLength={20} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <SendButton type="submit" variant="primary" disabled={save.isPending || value.trim() === ""}>
        保存する
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
