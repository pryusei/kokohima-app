import { blockedUserPageSchema, type BlockedUser } from "@kokohima/shared";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { nameOfProfile } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Button, SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Note } from "../ui/feedback";
import { SubScreen } from "../ui/Navigation";

// 設定の「ブロックした人」（docs/specs/T-33-block-report.md「振る舞い 3.」）。やめても友達には戻らない（招待リンクでつながり直す）

const PAGE = 50;

function Row({ item }: { item: BlockedUser }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const name = nameOfProfile(item.user);
  const unblock = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/blocks/${item.user.id}`, undefined),
    onMutate: () => setFailed(false),
    onError: () => setFailed(true),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.blocks.list() }),
  });
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <Avatar name={item.user.displayName} src={item.user.avatarUrl} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <SendButton onClick={() => unblock.mutate()} pending={unblock.isPending} aria-label={`${name}のブロックをやめる`}>
          ブロックをやめる
        </SendButton>
      </div>
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          できませんでした。もう一度お試しください。
        </p>
      )}
    </li>
  );
}

export function BlockedUsersPage() {
  const list = useInfiniteQuery({
    queryKey: keys.blocks.list(),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiGet(`/api/v1/blocks?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, blockedUserPageSchema),
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <SubScreen title="ブロックした人" back="/settings">
      <Note>ブロックをやめても友達には戻りません。つながるときは招待リンクを送り直してください。</Note>
      {list.isPending && <Loading />}
      {list.isError && <LoadError retry={() => void list.refetch()} />}
      {list.isSuccess && items.length === 0 && <EmptyState title="ブロックした人はいません" />}
      {items.length > 0 && (
        <ul aria-label="ブロックした人" className="rounded-l bg-surface px-4 shadow-card">
          {items.map((item) => (
            <Row key={item.user.id} item={item} />
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
