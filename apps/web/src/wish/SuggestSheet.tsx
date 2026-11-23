import type { WishSuggestionCandidate } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { keys } from "../api/keys";
import { linkLabel } from "../invitations/format";
import { BottomSheet } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { streamWishSuggestion, suggestionQuotaQuery, type Stage } from "./suggest";

// 行きたいのAI提案のシート（docs/specs/T-29-wish-suggestion.md「画面」。モック：探す・候補・見つからなかったとき）。
// 入力 → 探している間 → 候補（または見つからない）を1つのシートの中で切り替える。候補はこのシートのメモリにだけ持つ。
// 閉じたら（シートが消えたら）ストリームを止める

export const CHIPS = ["ごはん", "カフェ", "飲み", "遊び", "雨でも行ける"] as const;
export const NOT_FOUND_TITLE = "候補が見つかりませんでした";
export const LIMIT_TEXT = "今日はもう探せません。明日またお試しください";

const STAGE_TEXT: Record<Stage, string> = {
  waiting: "探しています",
  searching: "Webで探しています",
  choosing: "候補を選んでいます",
};

export type PlaceDraft = { message: string; url: string; area: string };

/** チップの言葉を足す（すでにあれば足さない） */
export function addChip(query: string, chip: string) {
  const words = query.split(/[、,\s]+/).filter((w) => w !== "");
  if (words.includes(chip)) return query;
  return words.length === 0 ? chip : `${query.trim()}、${chip}`;
}

function CandidateCard({ candidate, onPlace }: { candidate: WishSuggestionCandidate; onPlace: () => void }) {
  const host = linkLabel(candidate.url);
  return (
    <li className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
      <p className="font-bold">{candidate.message}</p>
      <p className="text-s text-ink-muted">{candidate.reason}</p>
      {candidate.area && <p className="text-s text-ink-muted">エリア：{candidate.area}</p>}
      {/* 画像は出さない（外のサイトを取りに行かない）。ドメインは punycode で出す */}
      <a
        href={candidate.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="flex flex-col gap-0.5 rounded-l border border-line bg-surface px-4 py-3 no-underline"
        aria-label={`${candidate.placeName}（${host ?? ""}）`}
      >
        <span className="line-clamp-2 font-bold text-ink">{candidate.placeName}</span>
        <span className="text-s text-ink-muted">{host}</span>
      </a>
      <Button size="s" className="self-start" onClick={onPlace}>
        行きたいに置く
      </Button>
    </li>
  );
}

type View = "form" | "searching" | "done";

export function SuggestSheet({ onClose, onPlace }: { onClose: () => void; onPlace: (draft: PlaceDraft) => void }) {
  const queryClient = useQueryClient();
  const quota = useQuery(suggestionQuotaQuery());
  const [area, setArea] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("form");
  const [stage, setStage] = useState<Stage>("waiting");
  const [searched, setSearched] = useState({ area: "", query: "" });
  const controller = useRef<AbortController | null>(null);

  // シートが消えたら、ストリームを止める（サーバーも Claude の呼び出しを止める）
  useEffect(() => () => controller.current?.abort(), []);

  const search = useMutation({
    mutationFn: (body: { area: string; query: string }) => {
      controller.current?.abort();
      const c = new AbortController();
      controller.current = c;
      return streamWishSuggestion(body, { signal: c.signal, onStage: setStage });
    },
    onMutate: (body) => {
      setSearched(body);
      setStage("waiting");
      setView("searching");
    },
    onSettled: () => {
      setView("done");
      void queryClient.invalidateQueries({ queryKey: keys.wishes.suggestionQuota() });
    },
  });

  const remaining = quota.data?.remaining ?? 0;
  const limited = search.error instanceof ApiError && search.error.status === 429;
  const candidates = search.data ?? [];

  return (
    <BottomSheet title="行きたいを探す" label="行きたいを探す" onClose={onClose}>
      {view === "form" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            search.mutate({ area: area.trim(), query: query.trim() });
          }}
        >
          <Note>エリアとしたいことから、お店や場所の候補を探します。</Note>
          <Field label="どのあたり？">
            <input className={inputClass} value={area} maxLength={30} onChange={(e) => setArea(e.target.value)} />
          </Field>
          <Field label="何をしたい？">
            <input className={inputClass} value={query} maxLength={60} onChange={(e) => setQuery(e.target.value)} />
          </Field>
          <div role="group" aria-label="言葉を足す" className="flex flex-wrap gap-2">
            {CHIPS.map((chip) => (
              <Button key={chip} size="s" onClick={() => setQuery((q) => addChip(q, chip))}>
                {chip}
              </Button>
            ))}
          </div>
          <Note>入力した言葉だけをAIに渡します。友達やここ暇の情報は渡しません。</Note>
          <SendButton
            type="submit"
            variant="primary"
            block
            disabled={!quota.data || remaining === 0 || area.trim() === "" || query.trim() === ""}
          >
            候補を探す
          </SendButton>
          {quota.data && (
            <p role="status" className="text-center text-s text-ink-muted">
              {remaining === 0 ? LIMIT_TEXT : `今日はあと${remaining}回探せます`}
            </p>
          )}
        </form>
      )}

      {view === "searching" && (
        <div className="flex flex-col gap-3">
          <Note>
            {searched.area}・{searched.query}
          </Note>
          <div role="status" aria-label={STAGE_TEXT[stage]} className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
            <p className="text-ink-muted">{STAGE_TEXT[stage]}</p>
            <span className="h-3.5 w-3/4 rounded-s bg-surface-sunken" />
            <span className="h-3.5 w-full rounded-s bg-surface-sunken" />
          </div>
        </div>
      )}

      {view === "done" && (
        <div className="flex flex-col gap-3">
          <Note>
            {searched.area}・{searched.query}
          </Note>
          {limited ? (
            <p role="status" className="rounded-m bg-quiet-bg px-4 py-3 text-quiet-ink">
              {LIMIT_TEXT}
            </p>
          ) : candidates.length > 0 ? (
            <>
              <ul aria-label="候補" className="flex flex-col gap-3">
                {candidates.map((c) => (
                  <CandidateCard key={c.url} candidate={c} onPlace={() => onPlace({ message: c.message, url: c.url, area: c.area ?? searched.area })} />
                ))}
              </ul>
              <Note>AIがWebで探したお店です。営業時間や場所は、リンク先で確かめてください。</Note>
            </>
          ) : (
            <div role="status" className="flex flex-col gap-1 rounded-l border border-line bg-quiet-bg px-4 py-8 text-center text-quiet-ink">
              <p className="font-bold">{NOT_FOUND_TITLE}</p>
              <p className="text-s">エリアを広げるか、言葉を変えてお試しください。</p>
            </div>
          )}
          <Button variant="ghost" block onClick={() => setView("form")}>
            言葉を変えて探す
          </Button>
          {!limited && candidates.length === 0 && <Note>探せる回数には数えません</Note>}
        </div>
      )}
    </BottomSheet>
  );
}
