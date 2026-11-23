import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";
import { parseSseChunk } from "../wish/suggest";
import { addChip } from "../wish/SuggestSheet";

// 行きたいのAI提案（docs/specs/T-29-wish-suggestion.md「画面」「テスト計画」）

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const candidate = (n: number, area: string | null = n === 2 ? "代官山" : null) => ({
  message: `店${n}のつけ麺行きたい`,
  placeName: `店${n}`,
  url: `https://shop${n}.example/menu`,
  reason: `理由${n}`,
  area,
});

beforeEach(() => {
  tokenStore.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Routes = Parameters<typeof mockFetch>[0];

const quota = (remaining: number, limit = 5) => json({ remaining, limit });

/** ストリームの応答。chunks を1つずつ流す（hold を渡すと、resolve されるまで最後を流さない） */
function sseResponse(chunks: string[], hold?: Promise<void>) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [i, c] of chunks.entries()) {
        if (hold && i === chunks.length - 1) await hold;
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const availabilityTab = (over: Routes = {}) => {
  window.history.replaceState(null, "", "/availability");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/me/presets": presets,
    "/api/v1/availabilities": empty,
    "/api/v1/recurrence-rules": empty,
    "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    "/api/v1/wishes": empty,
    "/api/v1/friends": json({ items: [], nextCursor: null }),
    "/api/v1/wish-suggestions/quota": quota(4),
    ...over,
  });
};

async function openSheet() {
  renderApp();
  await userEvent.click(await screen.findByRole("button", { name: "AIで探す" }));
  return screen.findByRole("dialog", { name: "行きたいを探す" });
}

async function fill(dialog: HTMLElement, area = "渋谷", query = "ラーメン") {
  await userEvent.type(within(dialog).getByLabelText("どのあたり？"), area);
  await userEvent.type(within(dialog).getByLabelText("何をしたい？"), query);
}

describe("部品", () => {
  it("SSE の本文を、途中で切れた分を残してイベントに分ける。コメントの行は捨てる", () => {
    const { events, rest } = parseSseChunk(`: keep-alive\n\n${ev("progress", { stage: "searching" })}event: result\ndata: {"cand`);
    expect(events).toEqual([{ event: "progress", data: '{"stage":"searching"}' }]);
    expect(rest).toBe('event: result\ndata: {"cand');
  });

  it("チップは言葉を足し、同じ言葉は重ねない", () => {
    expect(addChip("", "カフェ")).toBe("カフェ");
    expect(addChip("ラーメン", "雨でも行ける")).toBe("ラーメン、雨でも行ける");
    expect(addChip("ラーメン、カフェ", "カフェ")).toBe("ラーメン、カフェ");
  });
});

describe("AIで探す", () => {
  it("limit が0（設定がない）・読めないときは「AIで探す」を出さない", async () => {
    availabilityTab({ "/api/v1/wish-suggestions/quota": quota(0, 0) });
    renderApp();
    expect(await screen.findByRole("button", { name: "＋ 行きたいを置く" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("button", { name: "AIで探す" })).toBeNull());
  });

  it("入力とチップ、残りの回数。エリアと言葉がそろうまで押せない", async () => {
    availabilityTab();
    const dialog = await openSheet();
    expect(within(dialog).getByText("今日はあと4回探せます")).toBeVisible();
    expect(within(dialog).getByText("入力した言葉だけをAIに渡します。友達やここ暇の情報は渡しません。")).toBeVisible();
    const submit = within(dialog).getByRole("button", { name: "候補を探す" });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("どのあたり？"), "渋谷");
    await userEvent.click(within(dialog).getByRole("button", { name: "カフェ" }));
    expect(within(dialog).getByLabelText("何をしたい？")).toHaveValue("カフェ");
    expect(submit).toBeEnabled();
  });

  it("残りが0なら押せず、静かな文言を出す", async () => {
    availabilityTab({ "/api/v1/wish-suggestions/quota": quota(0) });
    const dialog = await openSheet();
    await fill(dialog);
    expect(within(dialog).getByRole("button", { name: "候補を探す" })).toBeDisabled();
    expect(within(dialog).getByText("今日はもう探せません。明日またお試しください")).toBeVisible();
  });

  it("進み具合を出し、3件の候補を出す。「行きたいに置く」で置くシートに3つの値が入る。候補をストレージに置かない", async () => {
    let release = () => {};
    const hold = new Promise<void>((r) => (release = r));
    let releaseChoosing = () => {};
    const holdChoosing = new Promise<void>((r) => (releaseChoosing = r));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { calls } = availabilityTab({
      "/api/v1/wish-suggestions": () => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(ev("progress", { stage: "searching" })));
            await holdChoosing;
            controller.enqueue(encoder.encode(ev("progress", { stage: "choosing" })));
            await hold;
            controller.enqueue(encoder.encode(ev("result", { candidates: [candidate(1), candidate(2), candidate(3)] })));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
      },
    });
    const dialog = await openSheet();
    await fill(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "候補を探す" }));
    expect(await within(dialog).findByText("Webで探しています")).toBeVisible();
    releaseChoosing();
    expect(await within(dialog).findByText("候補を選んでいます")).toBeVisible();
    // 探している間は、もう一度押せない（ボタンがない）
    expect(within(dialog).queryByRole("button", { name: "候補を探す" })).toBeNull();
    release();
    const list = await within(dialog).findByRole("list", { name: "候補" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("理由2")).toBeVisible();
    expect(within(list).getByText("エリア：代官山")).toBeVisible();
    expect(within(list).getAllByText(/^エリア：/)).toHaveLength(1);
    expect(within(list).getByRole("link", { name: "店1（shop1.example）" })).toHaveAttribute("href", "https://shop1.example/menu");
    expect(within(dialog).getByText("AIがWebで探したお店です。営業時間や場所は、リンク先で確かめてください。")).toBeVisible();
    const post = calls.find((c) => c.url === "/api/v1/wish-suggestions");
    expect(JSON.parse(String(post?.init.body))).toEqual({ area: "渋谷", query: "ラーメン" });

    await userEvent.click(within(list).getAllByRole("button", { name: "行きたいに置く" })[1]!);
    const place = await screen.findByRole("dialog", { name: "行きたいを置く" });
    expect(within(place).getByText("候補から入れました。直してから置けます。")).toBeVisible();
    expect(within(place).getByLabelText("ひとこと")).toHaveValue("店2のつけ麺行きたい");
    expect(within(place).getByLabelText("リンク（任意）")).toHaveValue("https://shop2.example/menu");
    // エリアは候補の店の場所（代官山）。候補にエリアがなければ、探したときのエリア
    expect(within(place).getByLabelText("エリア（任意）")).toHaveValue("代官山");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("候補にエリアがなければ、置くシートには探したときのエリアを入れる", async () => {
    availabilityTab({
      "/api/v1/wish-suggestions": sseResponse([ev("result", { candidates: [candidate(1, null)] })]),
    });
    const dialog = await openSheet();
    await fill(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "候補を探す" }));
    await userEvent.click(await within(dialog).findByRole("button", { name: "行きたいに置く" }));
    const place = await screen.findByRole("dialog", { name: "行きたいを置く" });
    expect(within(place).getByLabelText("エリア（任意）")).toHaveValue("渋谷");
  });

  it.each([
    ["0件", sseResponse([ev("progress", { stage: "searching" }), ev("result", { candidates: [] })])],
    ["result が来ないまま閉じた", sseResponse([ev("progress", { stage: "searching" })])],
    ["503", json({ type: "about:blank", title: "x", status: 503, code: "unavailable", requestId: "r" }, 503)],
  ])("%s：赤を使わない静かな「候補が見つかりませんでした」と、言葉を変えて探す", async (_name, route) => {
    availabilityTab({ "/api/v1/wish-suggestions": route });
    const dialog = await openSheet();
    await fill(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "候補を探す" }));
    const box = await within(dialog).findByText("候補が見つかりませんでした");
    expect(box.parentElement?.className).toMatch(/bg-quiet-bg/);
    expect(box.parentElement?.className).not.toMatch(/red|rose|error|warn/);
    expect(within(dialog).getByText("探せる回数には数えません")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "言葉を変えて探す" }));
    expect(within(dialog).getByLabelText("何をしたい？")).toHaveValue("ラーメン");
  });

  it("429 は「今日はもう探せません」", async () => {
    availabilityTab({
      "/api/v1/wish-suggestions": json({ type: "about:blank", title: "x", status: 429, code: "rate_limited", requestId: "r" }, 429),
    });
    const dialog = await openSheet();
    await fill(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "候補を探す" }));
    expect(await within(dialog).findAllByText("今日はもう探せません。明日またお試しください")).not.toHaveLength(0);
  });

  it("閉じたらストリームを止める", async () => {
    let signal: AbortSignal | undefined;
    availabilityTab({
      "/api/v1/wish-suggestions": ({ init }) => {
        signal = init.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });
    const dialog = await openSheet();
    await fill(dialog);
    await userEvent.click(within(dialog).getByRole("button", { name: "候補を探す" }));
    expect(await within(dialog).findByText("探しています")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

void uuid;
