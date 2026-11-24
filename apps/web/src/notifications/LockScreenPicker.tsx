import type { LockScreen } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { LoadError } from "../ui/feedback";
import { useOnline } from "../ui/online";
import { useUpdatePreferences } from "./preferences";
import { preferencesQuery } from "./queries";

// ロック画面の見え方を、見本を2つ並べて選ぶ（docs/specs/T-35-notification-visibility.md「画面」）。
// 初期値は「出さない」。選んだらすぐ保存する。説明は1行だけにし、見本で伝える

const OPTIONS: { value: LockScreen; label: string; sample: string[] }[] = [
  { value: "hidden", label: "出さない", sample: ["誘いが届きました"] },
  { value: "detailed", label: "名前と日時を出す", sample: ["ゆいさんから誘いが届きました", "11月28日(土) 19:00〜"] },
];

/** 見本のロック画面。読み上げでは選択肢の名前と見本の文だけを読む */
function Sample({ lines }: { lines: string[] }) {
  return (
    <span aria-hidden="true" className="flex flex-col items-center gap-2 rounded-m bg-head px-2 pt-3 pb-4">
      <span className="text-xl font-bold tabular-nums text-ink">21:04</span>
      <span className="flex w-full flex-col gap-0.5 rounded-m bg-surface px-2 py-2 text-left shadow-card">
        <span className="flex items-center gap-1 text-xxs text-ink-muted">
          <span className="inline-block size-3 rounded-s bg-lamp" />
          ここ暇
        </span>
        {lines.map((line, i) => (
          <span key={line} className={i === 0 ? "text-xs font-bold text-ink" : "text-xxs text-ink-muted"}>
            {line}
          </span>
        ))}
      </span>
    </span>
  );
}

/** hint：下の1行の説明を出すか（友達になった直後の画面は説明を1行に抑えるので出さない。T-31） */
export function LockScreenPicker({ hint = true }: { hint?: boolean }) {
  const preferences = useQuery(preferencesQuery());
  const [failed, setFailed] = useState(false);
  const update = useUpdatePreferences(() => setFailed(true));
  const online = useOnline();
  const name = useId();
  // 読み込むまでは、どちらにも印を付けない（保存した値と違う方が一瞬選ばれて見えないように）
  const current = preferences.data?.lockScreen ?? null;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-bold">ロック画面に出す中身</legend>
      <div className="grid grid-cols-2 gap-3">
        {OPTIONS.map((o) => {
          const checked = current === o.value;
          return (
            <label
              key={o.value}
              className={`flex cursor-pointer flex-col gap-2 rounded-l border-2 bg-surface p-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                checked ? "border-lamp-line shadow-lamp" : "border-line"
              }`}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                className="sr-only"
                checked={checked}
                disabled={!preferences.data || !online}
                onChange={() => {
                  setFailed(false);
                  update.mutate({ lockScreen: o.value });
                }}
                aria-describedby={`${name}-${o.value}`}
              />
              <Sample lines={o.sample} />
              <span className="flex items-center justify-center gap-1 text-s font-bold">
                <span
                  aria-hidden="true"
                  className={`inline-block size-4 rounded-full border-2 ${checked ? "border-lamp-line bg-lamp" : "border-line-strong"}`}
                />
                {o.label}
              </span>
            </label>
          );
        })}
      </div>
      {/* 見本の文の読み上げ（ラベルの名前に混ぜないよう、ラベルの外に置く） */}
      {OPTIONS.map((o) => (
        <span key={o.value} id={`${name}-${o.value}`} className="sr-only">
          見本：{o.sample.join(" ")}
        </span>
      ))}
      {preferences.isError && !preferences.data && (
        <LoadError text="今の設定を読み込めませんでした。もう一度お試しください" retry={() => void preferences.refetch()} />
      )}
      {hint && <p className="text-s text-ink-muted">どちらでも、ひとこと・場所・リンクは出ません</p>}
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          変更できませんでした。もう一度お試しください
        </p>
      )}
    </fieldset>
  );
}
