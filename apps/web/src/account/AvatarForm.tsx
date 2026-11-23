import { meResponseSchema, type MeResponse } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { apiFetch, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Avatar } from "../ui/Avatar";
import { Button, SendButton, buttonClass } from "../ui/Button";
import { Note } from "../ui/feedback";
import { useOnline } from "../ui/online";
import { makeAvatarJpeg } from "./avatarImage";

// アイコンの画像の設定（docs/specs/T-27-avatar-upload.md「画面」）。設定のアカウントと、初回設定（T-15）で使う。
// 作り直した画像はメモリにだけ置く（localStorage などに保存しない）

type Draft = { blob: Blob; preview: string };

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export function AvatarForm({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const saved = (next: MeResponse | undefined) => {
    if (next) queryClient.setQueryData(keys.me(), next);
    else queryClient.setQueryData(keys.me(), { ...me, avatarUrl: null });
    // 自分が出る一覧（予定の参加者など）にも新しいアイコンを出す
    void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== keys.me()[0] });
  };

  const upload = useMutation({
    mutationFn: async (blob: Blob) => {
      const res = await apiFetch("/api/v1/me/avatar", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: blob });
      return meResponseSchema.parse(await res.json());
    },
    onSuccess: (next) => {
      setDraft(null);
      setMessage("アイコンを変えました");
      saved(next);
    },
    onError: () => setMessage("アイコンを変えられませんでした。もう一度お試しください。"),
  });
  const remove = useMutation({
    mutationFn: () => apiSend("DELETE", "/api/v1/me/avatar", undefined),
    onSuccess: () => {
      setMessage("アイコンを外しました");
      saved(undefined);
    },
    onError: () => setMessage("アイコンを外せませんでした。もう一度お試しください。"),
  });
  const busy = upload.isPending || remove.isPending;

  const choose = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    setMessage(null);
    try {
      const blob = await makeAvatarJpeg(file);
      setDraft({ blob, preview: await readAsDataUrl(blob) });
    } catch {
      setDraft(null);
      setMessage("この画像は使えません。ほかの画像を選んでください。");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        {draft ? (
          <span aria-hidden="true" className="inline-grid size-16 shrink-0 overflow-hidden rounded-full bg-surface-sunken">
            <img src={draft.preview} alt="" className="size-full object-cover" />
          </span>
        ) : (
          <Avatar name={me.displayName} src={me.avatarUrl} size="l" />
        )}
        <p className="text-s text-ink-muted">
          {draft ? "この画像にしますか？（中央を丸く切り抜きます）" : "友達と、招待リンクを開いた人にだけ見えます。"}
        </p>
      </div>
      {draft ? (
        <div className="flex gap-2">
          <SendButton variant="primary" disabled={busy || !online} onClick={() => upload.mutate(draft.blob)}>
            この画像にする
          </SendButton>
          <Button disabled={busy} onClick={() => setDraft(null)}>
            やめる
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {/* ファイルの選択はラベルで開く（ボタンの見た目にする） */}
          <label htmlFor={inputId} className={`${buttonClass("secondary")} ${busy || !online ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
            画像を選ぶ
          </label>
          <input
            id={inputId}
            ref={input}
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={busy || !online}
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          {me.avatarUrl && (
            <Button disabled={busy || !online} onClick={() => remove.mutate()}>
              アイコンを外す
            </Button>
          )}
        </div>
      )}
      {!online && <Note>オフラインの間はアイコンを変えられません</Note>}
      {message && (
        <p role="status" className="text-s text-ink-muted">
          {message}
        </p>
      )}
    </div>
  );
}
