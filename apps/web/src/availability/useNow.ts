import { useEffect, useState } from "react";

/** 今の時刻。interval ごとに描き直す（「今」の印と、今ひまのボタンの時刻のため。docs/specs/T-40-ima-hima.md） */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
