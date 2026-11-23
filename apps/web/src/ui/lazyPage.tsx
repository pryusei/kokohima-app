import { lazy, type ComponentType } from "react";
import { LoadError } from "./feedback";

// ページの遅延読み込み（docs/specs/T-49-perf-small-fixes.md「4.」）。
// チャンクを読めなかったとき（オフライン・デプロイでファイルの名前が変わった）は、画面を落とさず静かに知らせ、
// 「もう一度」で読み直す（React.lazy は失敗を覚えてしまうので、ページごと読み直す）

/** 読めなかったときの画面。押すとページを読み直す */
export function ChunkLoadError({ reload = () => window.location.reload() }: { reload?: () => void }) {
  return (
    <main className="mx-auto max-w-md p-6">
      <LoadError text="読み込めませんでした。通信状態を確認して、もう一度お試しください" retry={reload} />
    </main>
  );
}

/** 名前付きで export したページを React.lazy で読む */
export function lazyPage<M>(load: () => Promise<M>, pick: (m: M) => ComponentType) {
  const failed: ComponentType = () => <ChunkLoadError />;
  return lazy(() =>
    load().then(
      (m) => ({ default: pick(m) }),
      () => ({ default: failed }),
    ),
  );
}
