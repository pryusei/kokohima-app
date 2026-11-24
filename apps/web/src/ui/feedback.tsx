import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Collapse, useAppear } from "./Collapse";
import { useOnline } from "./online";

// 空の状態・読み込み中・読み込めない・オフライン（デザインシステム「EmptyState」「StatusStates」）。操作の結果は ResultBand.tsx
// どれも赤や警告の印を使わず、surface-sunken の静かな帯で出す

/** 空の状態。出るときに下から8pxのフェードで入る（docs/specs/T-56-motion.md「M-19」。止まった形が最終形） */
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex animate-kh-rise flex-col items-center gap-3 px-6 py-10 text-center">
      <span aria-hidden="true" className="relative h-16 w-14 rounded-t-l rounded-b-s border-2 border-line-strong bg-surface-sunken">
        <span className="absolute inset-2.5 rounded-s bg-lamp-soft" />
      </span>
      <p className="text-l font-bold">{title}</p>
      {description && <p className="text-s text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}

const BAR = "rounded-s bg-surface-sunken";

/**
 * 読み込み中の骨組み（docs/specs/T-56-motion.md「M-06」）。くるくる回る印は使わない。
 * 形は variant で決め、数は件数によらず固定（見せない相手と暇がない相手を、読み込みの形で区別させない）。
 * card：カード（既定）、list：丸と2行の棒を3行、chips：日付の帯と丸いチップの棒を2行。
 * 200ms の遅れのあとに出て、ゆっくり明滅する（index.css の .kh-skeleton。止まった形が最終形なので、動きを止める設定ではすぐに見える）
 */
export function Loading({ variant = "card" }: { variant?: "card" | "list" | "chips" }) {
  if (variant === "list") {
    return (
      <div role="status" aria-label="読み込み中" data-variant="list" className="kh-skeleton flex flex-col rounded-l bg-surface px-4 shadow-card">
        {[0, 1, 2].map((i) => (
          <span key={i} className="flex items-center gap-3 border-b border-line py-3 last:border-b-0">
            <span className="size-10 shrink-0 rounded-full bg-surface-sunken" />
            <span className="flex flex-1 flex-col gap-2">
              <span className={`h-3.5 w-1/3 ${BAR}`} />
              <span className={`h-3 w-2/3 ${BAR}`} />
            </span>
          </span>
        ))}
      </div>
    );
  }
  if (variant === "chips") {
    return (
      <div role="status" aria-label="読み込み中" data-variant="chips" className="kh-skeleton flex flex-col">
        <span className="-mx-4 h-8 bg-head lg:-mx-6" />
        {[0, 1].map((i) => (
          <span key={i} className="flex gap-2 border-b border-line py-3 last:border-b-0">
            <span className="size-10 shrink-0 rounded-full bg-surface-sunken" />
            <span className="flex flex-1 flex-col gap-2">
              <span className={`h-3.5 w-1/4 ${BAR}`} />
              <span className="h-7 w-32 rounded-full bg-surface-sunken" />
            </span>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div role="status" aria-label="読み込み中" data-variant="card" className="kh-skeleton flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
      <span className={`h-3.5 w-2/5 ${BAR}`} />
      <span className={`h-3.5 w-3/4 ${BAR}`} />
      <span className={`h-3.5 w-full ${BAR}`} />
    </div>
  );
}

/**
 * 読み込み中のあと最初に描く中身を、フェードで入れる（M-06・M-08）。描いたときだけ動き、取り直しでは動かない。
 * 止まった形が最終形（opacity-0 を普段のクラスに置かない）。className は入れ物の並べ方
 */
export function FadeIn({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`kh-fade${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** 読み込めないとき。retry があれば「もう一度」を出す */
export function LoadError({
  text = "読み込めませんでした。もう一度お試しください",
  retry,
  retrySize = "s",
}: {
  text?: string;
  retry?: () => void;
  /** 「もう一度」の大きさ。その画面の操作が「もう一度」だけのときは m（docs/specs/T-49-perf-small-fixes.md「4.」） */
  retrySize?: "s" | "m";
}) {
  return (
    <div className="flex items-center gap-3 rounded-m bg-surface-sunken px-4 py-3">
      <p role="status" className="min-w-0 flex-1">
        {text}
      </p>
      {retry && (
        <Button size={retrySize} onClick={retry}>
          もう一度
        </Button>
      )}
    </div>
  );
}

/**
 * オフラインの帯（docs/specs/T-11-design.md「オフライン」）。出るとき・消えるときに高さを開閉する（docs/specs/T-56-motion.md「V-2」。
 * 中身が帯の高さだけ瞬間で下がらない）。つながっているあいだは、閉じ終わったら入れ物ごと描かない
 */
/**
 * オフラインの帯。親の flex の gap の分（gap：main は m＝16px、シートの見出しの行は s＝8px）を帯の中の下の余白に持ち、
 * 入れ物の負の余白で親の gap を打ち消す（出し入れの瞬間に gap の分だけ下の中身が跳ねない。V-2）
 */
export function OfflineBanner({ gap = "m" }: { gap?: "m" | "s" }) {
  const online = useOnline();
  const [mounted, setMounted] = useState(!online);
  if (!online && !mounted) setMounted(true);
  if (!mounted) return null;
  return <OfflineBannerBody online={online} gap={gap} onHidden={() => setMounted(false)} />;
}

const BANNER_GAP = { m: { outer: "-mb-4", inner: "pb-4" }, s: { outer: "-mb-2", inner: "pb-2" } } as const;

function OfflineBannerBody({ online, gap, onHidden }: { online: boolean; gap: "m" | "s"; onHidden: () => void }) {
  const appeared = useAppear();
  return (
    <Collapse show={!online && appeared} onHidden={onHidden} className={BANNER_GAP[gap].outer}>
      <div className={BANNER_GAP[gap].inner}>
        <div className="flex items-center gap-3 rounded-m bg-surface-sunken px-4 py-3">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-ink-muted" />
          <p role="status" className="min-w-0 flex-1">
            オフラインです。つながると最新の内容になります
          </p>
        </div>
      </div>
    </Collapse>
  );
}

/** 補助の説明 */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-s text-ink-muted">{children}</p>;
}
