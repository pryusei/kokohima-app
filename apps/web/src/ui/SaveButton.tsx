import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SendButton } from "./Button";

// 保存のボタン（docs/specs/T-54-save-and-goodbye-copy.md）。表示名と時間帯プリセットで同じ動きにする。
// 変えていないあいだは押せない。保存できたら、ボタンそのものが約2秒「✓ 保存しました」（操作の青の枠）になり、元に戻る。
// 送信中は灰色にせず、元の色のまま薄くして「保存しています…」にする（docs/specs/T-56-motion.md「M-14」）。色の切り替えは --duration-fast

/** unchanged＝保存済みの値と同じ（押せない）、changed＝変えた（押せる）、saving＝送信中、saved＝保存できた直後 */
export type SaveState = "unchanged" | "changed" | "saving" | "saved";

/** 「✓ 保存しました」を出しておく時間 */
export const SAVED_MS = 2000;

/** 保存のボタンの状態を決める。保存できたら markSaved を呼ぶ */
export function useSaveState({ changed, pending }: { changed: boolean; pending: boolean }) {
  const [justSaved, setJustSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const markSaved = useCallback(() => {
    clearTimeout(timer.current);
    setJustSaved(true);
    timer.current = setTimeout(() => setJustSaved(false), SAVED_MS);
  }, []);
  // 「✓ 保存しました」のあいだに入力を変えたら、すぐ押せるボタンに戻す
  const state: SaveState = pending ? "saving" : changed ? "changed" : justSaved ? "saved" : "unchanged";
  return { state, markSaved };
}

/** 「✓ 保存しました」「✓ 送りました」の中身。「✓」は読み上げない（読み上げはボタンの外の status） */
export function DoneLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span aria-hidden="true">✓</span>
      {children}
    </>
  );
}

/** フォームの送信ボタン。読み上げは、ボタンの外の見えない status で「保存しました」と伝える */
export function SaveButton({ state, block, children }: { state: SaveState; block?: boolean; children: ReactNode }) {
  const saved = state === "saved";
  const saving = state === "saving";
  return (
    <>
      <SendButton
        type="submit"
        variant={saved ? "saved" : "primary"}
        block={block}
        disabled={state === "unchanged" || saved}
        pending={saving}
        className="kh-submit-motion"
      >
        {saved ? <DoneLabel>保存しました</DoneLabel> : saving ? "保存しています…" : children}
      </SendButton>
      <p role="status" className="sr-only">
        {saved ? "保存しました" : ""}
      </p>
    </>
  );
}
