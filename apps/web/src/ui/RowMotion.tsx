import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Collapse } from "./Collapse";
import { prefersReducedMotion } from "./motion";

// 自分の操作で増える・消える行（docs/specs/T-56-motion.md「M-10」）。
// 消える：行を Collapse で閉じ、閉じ終わってから描かない（下の行は高さの変化で滑って詰まる）。
// 増える：シートが閉じ終わってから Collapse で開き、開いたあとに一度だけ地を surface-sunken から元の色へ戻す。
// 対象は自分の操作で増減した行だけ。友達の側のデータ（みんなタブ、友達の詳細の行きたい、受信の一覧）には使わない（見えなくなったことを動きで見せない）。
// どの行が「自分が増やした行」かは、作成の応答の ID をメモリに持って決める（一度光ったら消す。localStorage などには置かない）

const created = new Set<string>();

/** 作成の応答の ID を覚える。次にその行を描いたときに、開く動きと光る動きを1回だけ出す */
export function markCreatedRow(id: string) {
  created.add(id);
}

/**
 * 出入りの途中の行。leaving：消える動きの途中、gone：閉じ終わった（一覧から消えるのを待つ）、back：失敗して戻った（描いたら開く）。
 * absent：一覧から先に消えた（楽観的更新）。index と item は、一覧から消えたあとも元の場所に描くため
 */
type Exit<T> = { item: T; index: number; phase: "leaving" | "gone" | "back"; absent: boolean };

export type MotionRowState<T> = {
  key: string;
  item: T;
  /** 消える動きの途中 */
  leaving: boolean;
  /** 描いたときに開く（増えた行・失敗して戻った行） */
  appear: boolean;
  /** 開いたあとに一度だけ光る（自分が増やした行） */
  glow: boolean;
};

/**
 * 一覧の行の出入り。leave(key) で消える動きを始める（楽観的更新で一覧から先に消えても、閉じ終わるまで元の場所に描く）。
 * 楽観的更新が失敗して行が一覧に戻ったとき・restore(key) のときは、元の場所に開いて戻る。
 * 一覧から消える前に閉じ終わった行（読み直しを待つあいだ）は描かない
 */
export function useRowExits<T>(items: readonly T[], keyOf: (item: T) => string) {
  const [exits, setExits] = useState<ReadonlyMap<string, Exit<T>>>(() => new Map());
  const latest = useRef(items);
  useEffect(() => {
    latest.current = items;
  }, [items]);

  const present = new Set(items.map(keyOf));
  // 一覧から消えた・戻ったことを、描画の中で反映する（React の「props の変化に合わせて状態を調整する」書き方）
  let changed: Map<string, Exit<T>> | null = null;
  for (const [key, exit] of exits) {
    const here = present.has(key);
    if (exit.phase === "back") continue;
    if (!exit.absent && !here) {
      (changed ??= new Map(exits)).set(key, { ...exit, absent: true });
    } else if (exit.absent && here) {
      // 楽観的更新で消したあと、失敗して一覧に戻った：元の場所に開いて戻る
      (changed ??= new Map(exits)).set(key, { ...exit, phase: "back", absent: false });
    }
  }
  if (changed) setExits(changed);

  const leave = useCallback(
    (key: string) => {
      const index = latest.current.findIndex((i) => keyOf(i) === key);
      const item = latest.current[index];
      if (item === undefined) return;
      setExits((m) => new Map(m).set(key, { item, index, phase: "leaving", absent: false }));
    },
    [keyOf],
  );
  /** 失敗して戻す（楽観的更新でない操作。一覧には残っている） */
  const restore = useCallback((key: string) => {
    setExits((m) => {
      const exit = m.get(key);
      if (!exit) return m;
      const next = new Map(m);
      // 閉じ終わっていれば、開いて戻す。閉じる途中なら、Collapse がそのまま開いた形へ戻す
      if (exit.phase === "gone") next.set(key, { ...exit, phase: "back" });
      else next.delete(key);
      return next;
    });
  }, []);
  const hidden = useCallback((key: string) => {
    setExits((m) => {
      const exit = m.get(key);
      if (!exit || exit.phase !== "leaving") return m;
      // 一覧から消えたあとも印は残す（失敗して戻ったときに、開いて戻すため）
      return new Map(m).set(key, { ...exit, phase: "gone" });
    });
  }, []);
  /** 開く動きを始めた（増えた行の印・戻った行の印を消す） */
  const appeared = useCallback((key: string) => {
    created.delete(key);
    setExits((m) => {
      if (m.get(key)?.phase !== "back") return m;
      const next = new Map(m);
      next.delete(key);
      return next;
    });
  }, []);

  const rows: MotionRowState<T>[] = [];
  for (const item of items) {
    const key = keyOf(item);
    const exit = exits.get(key);
    if (exit?.phase === "gone") continue;
    const isNew = created.has(key);
    rows.push({ key, item, leaving: exit?.phase === "leaving", appear: isNew || exit?.phase === "back", glow: isNew });
  }
  // 一覧から先に消えた行は、閉じ終わるまで元の場所に描く
  for (const [key, exit] of exits) {
    if (exit.absent && exit.phase === "leaving" && !present.has(key)) {
      rows.splice(Math.min(exit.index, rows.length), 0, { key, item: exit.item, leaving: true, appear: false, glow: false });
    }
  }

  return { rows, leave, restore, hidden, appeared };
}

/** シートが開いていないか（後ろの一覧の行を、シートが閉じ終わってから開くため） */
const noSheet = () => document.querySelector(".kh-sheet-scrim") === null;

/**
 * 1行。li を Collapse の入れ物にし、中身（className の並べ方・余白・線）はその中の要素に描く（li は閉じると高さが0になる）。
 * inSheet：シートの中の一覧（増えた行をすぐ開く）。後ろの一覧は、シートが閉じ終わってから開く。光る動きは index.css の .kh-row-glow
 */
export function MotionRow<T>({
  row,
  onHidden,
  onAppeared,
  inSheet = false,
  itemClassName,
  className,
  children,
}: {
  row: MotionRowState<T>;
  onHidden: (key: string) => void;
  onAppeared: (key: string) => void;
  inSheet?: boolean;
  /** li 自身に付ける（横に並べる一覧の縮まない幅など） */
  itemClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  // 描いたときに開く行は、閉じた形で描き始める（動きを止める設定では、すぐ開いた形）
  const [opening, setOpening] = useState(() => row.appear && !prefersReducedMotion());
  const [glow] = useState(() => row.glow);
  const { key, appear } = row;
  useEffect(() => {
    if (appear) onAppeared(key);
  }, [appear, key, onAppeared]);
  useEffect(() => {
    if (!opening) return;
    let frame = 0;
    // 閉じた形が描かれてから開く（2回あとのフレーム）
    const open = () => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setOpening(false));
      });
    };
    if (inSheet || noSheet()) {
      open();
      return () => cancelAnimationFrame(frame);
    }
    const observer = new MutationObserver(() => {
      if (!noSheet()) return;
      observer.disconnect();
      open();
    });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [opening, inSheet]);
  const onRowHidden = useCallback(() => onHidden(key), [onHidden, key]);
  const glowing = glow && !opening;
  return (
    <Collapse as="li" className={`group${itemClassName ? ` ${itemClassName}` : ""}`} show={!row.leaving && !opening} onHidden={onRowHidden}>
      <div data-row-glow={glowing ? "" : undefined} className={`${className ?? ""}${glowing ? " kh-row-glow" : ""}`}>
        {children}
      </div>
    </Collapse>
  );
}
