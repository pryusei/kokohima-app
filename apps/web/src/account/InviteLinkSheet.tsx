import { createdInviteLinkSchema, INVITE_DEFAULTS, type CreatedInviteLink } from "@kokohima/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { lineShareHref } from "../line/line";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, buttonClass, SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Chip, ChipRow, Field, inputClass } from "../ui/form";

// 招待リンクの発行のシート（docs/specs/T-02-friends.md、T-28「LINEで送る」）。
// 友達タブの「招待リンクを作る」と、友達が0人のときの「みんな」の「友達を招待する」（T-34）から開く。
// 表示名が未設定の人は名前の画面（T-31 の NameGate）で止まるので、ここでは名前を聞かない

/**
 * onCreated：作れたリンクの ID を受け取る。友達タブは markCreatedRow を渡し、「有効な招待リンク」の行を一度だけ光らせる（M-10）。
 * みんなタブ（友達0人。T-34）からは渡さない（その画面に行がないので、印が残って、あとで友達タブを開いたときに光らないように）
 */
export function InviteLinkSheet({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [expiresInDays, setExpiresInDays] = useState<1 | 3 | 7>(INVITE_DEFAULTS.expiresInDays);
  const [maxUses, setMaxUses] = useState<number>(INVITE_DEFAULTS.maxUses);
  const [created, setCreated] = useState<CreatedInviteLink | null>(null);

  const create = useMutation({
    mutationFn: () => apiSend("POST", "/api/v1/invite-links", { expiresInDays, maxUses }, createdInviteLinkSchema),
    onSuccess: (link) => {
      setCreated(link ?? null);
      // 友達タブの「有効な招待リンク」に、シートを閉じたあと開いて一度だけ光る（docs/specs/T-56-motion.md「M-10」）
      if (link) onCreated?.(link.id);
      void queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() });
    },
  });

  const share = async (url: string) => {
    if (navigator.share) await navigator.share({ url }).catch(() => undefined);
    else await navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <BottomSheet title="招待リンクを作る" label="招待リンクを作る" onClose={onClose}>
      <ChipRow label="使える期間">
        {([1, 3, 7] as const).map((d) => (
          <Chip key={d} selected={expiresInDays === d} onClick={() => setExpiresInDays(d)}>
            {d}日
          </Chip>
        ))}
      </ChipRow>
      <Field label="使える人数">
        <select className={inputClass} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}人
            </option>
          ))}
        </select>
      </Field>
      <SendButton variant="primary" block pending={create.isPending} onClick={() => create.mutate()}>
        招待リンクを作る
      </SendButton>
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          作れませんでした。時間をおいてもう一度お試しください。
        </p>
      )}
      {created && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <input aria-label="招待リンクのURL" readOnly className={`${inputClass} text-s`} value={created.url} />
          <Button variant="primary" onClick={() => void share(created.url)}>
            共有する
          </Button>
          {/* LINEのAPIは呼ばず、共有のURLを開くだけ。外のブラウザで開くよう openExternalBrowser=1 を付ける（T-28） */}
          <a className={buttonClass("secondary")} href={lineShareHref(created.url)} target="_blank" rel="noopener noreferrer">
            LINEで送る
          </a>
          <Note>このURLはこの画面でしか表示できません。今のうちに友達に送ってください。</Note>
        </div>
      )}
    </BottomSheet>
  );
}
