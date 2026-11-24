import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SendButton, type ButtonVariant } from "./Button";
import { prefersReducedMotion } from "./motion";
import { DoneLabel } from "./SaveButton";

// 送る操作のボタン（docs/specs/T-56-motion.md「M-03」）。状態は1つの値で渡す：
// ready＝押せる、sending＝送信中（M-14。元の色のまま薄く、押しても何もしない）、done＝「✓ 送りました」などを短く見せてから次へ進む。
// done の見た目は SaveButton の「✓ 保存しました」と同じ（variant saved、✓ は DoneLabel、読み上げはボタンの外の status）

export type SubmitState = "ready" | "sending" | "done";

/** done を見せる長さ */
export const SENT_HOLD_MS = 500;

/**
 * 送る操作のボタンの状態。成功したら succeed(next) を呼ぶ。
 * done を SENT_HOLD_MS 見せてから next を呼ぶ。動きを止める設定（jsdom を含む）では done を見せずにすぐ next を呼ぶ。
 * done のあいだにアンマウントされたら（閉じた・移った）、next は呼ばない
 */
export function useSubmitState(pending: boolean) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const succeed = useCallback((next: () => void) => {
    if (prefersReducedMotion()) {
      next();
      return;
    }
    setDone(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(next, SENT_HOLD_MS);
  }, []);
  const state: SubmitState = done ? "done" : pending ? "sending" : "ready";
  return { state, succeed };
}

type Props = {
  state: SubmitState;
  /** 送信中の文言（「送っています…」など） */
  sending: string;
  /** done の文言（「送りました」など。✓ は付けない） */
  done: string;
  variant?: ButtonVariant;
  /** 入力がそろっていない（灰色の押せないボタン） */
  disabled?: boolean;
  children: ReactNode;
};

/** フォームの送信ボタン（type="submit"）。押せるのは ready のときだけ */
export function SubmitButton({ state, sending, done, variant = "primary", disabled = false, children }: Props) {
  const isDone = state === "done";
  return (
    <>
      <SendButton
        type="submit"
        variant={isDone ? "saved" : variant}
        block
        disabled={!isDone && disabled}
        pending={state === "sending"}
        aria-disabled={state !== "ready" || undefined}
        // done のあいだも、押しても何もしない（フォームを送らない）
        onClick={(e) => {
          if (isDone) e.preventDefault();
        }}
        className="kh-submit-motion"
      >
        {isDone ? <DoneLabel>{done}</DoneLabel> : state === "sending" ? sending : children}
      </SendButton>
      <p role="status" className="sr-only">
        {isDone ? done : ""}
      </p>
    </>
  );
}
