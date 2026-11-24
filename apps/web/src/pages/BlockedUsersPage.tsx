import { blockedUserPageSchema, type BlockedUser } from "@kokohima/shared";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { nameOfProfile } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Button, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { SubScreen } from "../ui/Navigation";
import { MotionRow, useRowExits, type MotionRowState } from "../ui/RowMotion";

// 設定の「ブロックした人」（docs/specs/T-33-block-report.md「振る舞い 3.」）。やめても友達には戻らない（招待リンクでつながり直す）

const PAGE = 50;

type Exits = ReturnType<typeof useRowExits<BlockedUser>>;

/**
 * ブロックをやめた行は閉じて消え、失敗したら元の場所に開いて戻る（docs/specs/T-56-motion.md「M-10」）。押している間は地を沈める（M-11）。
 * 失敗の印は一覧の側に持つ（閉じ終わった行は描かないので、行の中の state は失敗が届く前に消える）
 */
function Row({
  row,
  exits,
  failed,
  setFailed,
}: {
  row: MotionRowState<BlockedUser>;
  exits: Exits;
  failed: boolean;
  setFailed: (key: string, failed: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const item = row.item;
  const name = nameOfProfile(item.user);
  const { leave, restore } = exits;
  const unblock = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/blocks/${item.user.id}`, undefined),
    onMutate: () => {
      setFailed(row.key, false);
      leave(row.key);
    },
    onError: () => {
      setFailed(row.key, true);
      restore(row.key);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.blocks.list() }),
  });
  return (
    <MotionRow
      row={row}
      onHidden={exits.hidden}
      onAppeared={exits.appeared}
      itemClassName="-mx-4"
      className="flex flex-col gap-1 border-b border-line px-4 py-3 transition-[background-color] duration-(--duration-press) group-last:border-b-0 active:bg-surface-sunken lg:hover:bg-surface-sunken"
    >
      <div className="flex items-center gap-3">
        <Avatar name={item.user.displayName} src={item.user.avatarUrl} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <SendButton onClick={() => unblock.mutate()} disabled={unblock.isPending} aria-label={`${name}のブロックをやめる`}>
          ブロックをやめる
        </SendButton>
      </div>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          できませんでした。もう一度お試しください。
        </p>
      )}
    </MotionRow>
  );
}

const blockedKey = (item: BlockedUser) => item.user.id;

export function BlockedUsersPage() {
  const list = useInfiniteQuery({
    queryKey: keys.blocks.list(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiGet(`/api/v1/blocks?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, blockedUserPageSchema),
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const exits = useRowExits(items, blockedKey);
  const [failed, setFailedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const setFailed = useCallback((key: string, value: boolean) => {
    setFailedKeys((s) => {
      if (s.has(key) === value) return s;
      const next = new Set(s);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  return (
    <SubScreen title="ブロックした人" back="/settings">
      <Note>ブロックをやめても友達には戻りません。つながるときは招待リンクを送り直してください。</Note>
      {list.isPending && <Loading variant="list" />}
      {list.isError && <LoadError retry={() => void list.refetch()} />}
      {list.isSuccess && items.length === 0 && <EmptyState title="ブロックした人はいません" />}
      {exits.rows.length > 0 && (
        <ul aria-label="ブロックした人" className="kh-fade rounded-l bg-surface px-4 shadow-card">
          {exits.rows.map((row) => (
            <Row key={row.key} row={row} exits={exits} failed={failed.has(row.key)} setFailed={setFailed} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          もっと見る
        </Button>
      )}
    </SubScreen>
  );
}
