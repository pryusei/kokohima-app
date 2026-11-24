import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, type Route } from "../test/helpers";
import { tokenBody } from "../test/helpers";

// ここ暇タブの週の帯（docs/specs/T-55-availability-week-grid.md「テスト計画」）
// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）。今日は 10/10（土）

const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const RULE_ID = "44444444-4444-4444-8444-444444444444";
const NEW_ID = "55555555-5555-4555-8555-555555555555";
const empty = json({ items: [], nextCursor: null });
const presets = json({
  day: { start: "11:00", end: "15:00" },
  evening: { start: "16:00", end: "19:00" },
  night: { start: "19:00", end: "23:00" },
});
const manual = {
  source: "manual",
  id: SLOT_ID,
  date: null,
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  label: "night",
};
const repeated = {
  source: "recurrence",
  id: RULE_ID,
  date: "2026-10-11",
  startsAt: "2026-10-11T02:00:00.000Z",
  endsAt: "2026-10-11T06:00:00.000Z",
  label: "day",
};
const createdNight = { ...manual, id: NEW_ID };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  tokenStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tab = (over: Record<string, Route | Route[]> = {}) => {
  window.history.replaceState(null, "", "/availability");
  return mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/me/presets": presets,
    "/api/v1/availabilities": json({ items: [manual, repeated], nextCursor: null }),
    "/api/v1/recurrence-rules": empty,
    "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    "/api/v1/wishes": empty,
    "/api/v1/wish-suggestions/quota": json({ limit: 0, remaining: 0 }),
    ...over,
  });
};

/** 名前の頭で探すマス（「10/10（土） 夜」など）。名前の残りに状態と押すと何が起きるかが入る */
const cell = (prefix: string) => screen.findByRole("button", { name: (name) => name.startsWith(`${prefix} `) });
const cellNow = (prefix: string) => screen.getByRole("button", { name: (name) => name.startsWith(`${prefix} `) });
/** 下に数秒出る一文の「取り消す」 */
const undoOf = async (text: string | RegExp) => within((await screen.findByText(text)).parentElement as HTMLElement).getByRole("button", { name: "取り消す" });
const sent = (calls: { url: string; init: RequestInit }[], method: string, url: string) =>
  calls.filter((c) => c.init.method === method && c.url === url);

describe("週の帯の形", () => {
  it("今日から7日×昼・夕方・夜のマス。名前に日付・時間帯・状態が入り、ここ暇には印（灯り・くり返しは点線）", async () => {
    tab();
    renderApp();
    const table = await screen.findByRole("table", { name: /ここ暇の週の帯/ });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(8);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "昼11:0011:00〜15:00",
      "夕方16:0016:00〜19:00",
      "夜19:0019:00〜23:00",
    ]);
    expect(screen.getByRole("heading", { name: "自分のここ暇 10/10〜10/16" })).toBeVisible();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/10（土） 夜 ここ暇 19:00〜23:00。押すと取り消す"));
    expect(night).toHaveAttribute("aria-pressed", "true");
    expect(night.className).toMatch(/bg-lamp-soft/);
    const day = cellNow("10/11（日） 昼");
    expect(day).toHaveAccessibleName("10/11（日） 昼 くり返しのここ暇 11:00〜15:00。押すとこの日だけ外す");
    expect(day.className).toMatch(/border-dashed/);
    const emptyCell = cellNow("10/12（月） 夕方");
    expect(emptyCell).toHaveAccessibleName("10/12（月） 夕方 16:00〜19:00。押すとここ暇にする");
    expect(emptyCell).toHaveAttribute("aria-pressed", "false");
    // マスは押せる大きさ（高さ48px）。赤を使わない
    expect(emptyCell.className).toMatch(/\bh-12\b/);
    expect(table.innerHTML).not.toMatch(/red|rose/);
  });

  it("「次の7日」で14日先まで。前に戻れる。それより先には進めない", async () => {
    tab();
    renderApp();
    await cell("10/16（金） 夜");
    await userEvent.click(screen.getByRole("button", { name: "次の7日 ›" }));
    expect(screen.getByRole("heading", { name: "自分のここ暇 10/17〜10/23" })).toBeVisible();
    expect(await cell("10/23（金） 夜")).toBeVisible();
    expect(screen.queryByRole("button", { name: (n) => n.startsWith("10/16（金） 夜 ") })).toBeNull();
    // 端の週では aria-disabled（押した直後にフォーカスを失わない）。押しても進まない
    const next = screen.getByRole("button", { name: "次の7日 ›" });
    expect(next).toHaveAttribute("aria-disabled", "true");
    expect(next).toHaveFocus();
    await userEvent.click(next);
    expect(screen.getByRole("heading", { name: "自分のここ暇 10/17〜10/23" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "前の7日" }));
    expect(await cell("10/10（土） 昼")).toBeVisible();
    expect(screen.getByRole("button", { name: "前の7日" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "前の7日" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "次の7日 ›" })).not.toHaveAttribute("aria-disabled");
  });

  it("プリセットが読めなければ、マスを押せず「読み込めませんでした」を出す", async () => {
    tab({ "/api/v1/me/presets": json({}, 500) });
    renderApp();
    expect(await screen.findByText("読み込めませんでした。もう一度お試しください")).toBeVisible();
    await waitFor(() => expect(cellNow("10/12（月） 夕方")).toBeDisabled());
  });

  it("今日の過ぎた時間帯（終わりが過ぎた）は押せない。始まっている時間帯は押せる", async () => {
    // 東京の 16:30
    vi.setSystemTime(new Date("2026-10-10T07:30:00Z"));
    tab({ "/api/v1/availabilities": empty });
    renderApp();
    const day = await cell("10/10（土） 昼");
    expect(day).toHaveAccessibleName("10/10（土） 昼 過ぎた時間帯");
    expect(day).toBeDisabled();
    await waitFor(() => expect(cellNow("10/10（土） 夕方")).toBeEnabled());
    expect(cellNow("10/11（日） 昼")).toBeEnabled();
  });

  it("時刻を指定した枠は、重なりの一番長い時間帯のマスに開始の時刻で出す", async () => {
    tab({
      "/api/v1/availabilities": json({
        items: [{ ...manual, label: null, startsAt: "2026-10-12T11:30:00.000Z", endsAt: "2026-10-12T14:30:00.000Z" }],
        nextCursor: null,
      }),
    });
    renderApp();
    const night = await cell("10/12（月） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/12（月） 夜 ここ暇 20:30〜23:30。押すと取り消す"));
    expect(night).toHaveTextContent("20:30");
  });
});

describe("押すとすぐ変わる（楽観的更新）と「取り消す」", () => {
  it("空のマスを押すと、日付とプリセットで作り、すぐ灯る。「取り消す」で作った枠を消す", async () => {
    let answer: (r: Response) => void = () => {};
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) =>
        init.method === "POST" ? new Promise<Response>((resolve) => (answer = resolve)) : empty(),
      [`/api/v1/availabilities/${NEW_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await cell("10/10（土） 夜"));
    // 応答の前にもう灯っている
    await waitFor(() => expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "true"));
    const [post] = sent(calls, "POST", "/api/v1/availabilities");
    expect(JSON.parse(String(post?.init.body))).toEqual({ date: "2026-10-10", preset: "night" });
    expect(new Headers(post?.init.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    answer(json(createdNight, 201)());
    await userEvent.click(await undoOf("10/10（土） 夜をここ暇にしました"));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${NEW_ID}`)).toHaveLength(1));
    expect(await screen.findByText("元に戻しました")).toBeVisible();
  });

  it("作れなければ（重なり・上限）すぐ戻して、静かな文言（赤を使わない）", async () => {
    tab({
      "/api/v1/availabilities": ({ init }) => (init.method === "POST" ? json({}, 409)() : empty()),
    });
    renderApp();
    await userEvent.click(await cell("10/11（日） 昼"));
    const message = await screen.findByText(/自分のほかのここ暇と重なっているか/);
    expect(message.className).not.toMatch(/red|rose/);
    await waitFor(() => expect(cellNow("10/11（日） 昼")).toHaveAttribute("aria-pressed", "false"));
  });

  it("ここ暇のマスを押すとすぐ取り消し、失敗したら元に戻して静かな文言を出す", async () => {
    let fail: (r: Response) => void = () => {};
    tab({
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Promise<Response>((resolve) => (fail = resolve)),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(night);
    await waitFor(() => expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "false"));
    // 送っている間は押しても送らない（フォーカスを失わないよう aria-disabled）
    expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-disabled", "true");
    fail(new Response(null, { status: 503 }));
    expect(await screen.findByText("変更できませんでした。もう一度お試しください。")).toBeVisible();
    await waitFor(() => expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "true"));
  });

  it("取り消したあとの「取り消す」は、同じ日付とプリセットで作り直す", async () => {
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) =>
        init.method === "POST" ? json(createdNight, 201)() : json({ items: [manual, repeated], nextCursor: null })(),
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(night);
    await userEvent.click(await undoOf("10/10（土） 夜のここ暇を取り消しました"));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/availabilities")).toHaveLength(1));
    expect(JSON.parse(String(sent(calls, "POST", "/api/v1/availabilities")[0]?.init.body))).toEqual({ date: "2026-10-10", preset: "night" });
  });

  it("くり返しのマスは「この日だけ外す」。「取り消す」で外した日を戻す", async () => {
    const { calls } = tab({
      [`/api/v1/recurrence-rules/${RULE_ID}/exceptions`]: () => new Response(null, { status: 204 }),
      [`/api/v1/recurrence-rules/${RULE_ID}/exceptions/2026-10-11`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const day = await cell("10/11（日） 昼");
    await waitFor(() => expect(day).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(day);
    await waitFor(() => expect(sent(calls, "POST", `/api/v1/recurrence-rules/${RULE_ID}/exceptions`)).toHaveLength(1));
    expect(JSON.parse(String(sent(calls, "POST", `/api/v1/recurrence-rules/${RULE_ID}/exceptions`)[0]?.init.body))).toEqual({
      date: "2026-10-11",
    });
    await userEvent.click(await undoOf("10/11（日） 昼だけ外しました（毎週はそのまま）"));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/recurrence-rules/${RULE_ID}/exceptions/2026-10-11`)).toHaveLength(1));
  });

  it("1つのマスに2つ以上あれば、押すとシートで1つずつ選べる", async () => {
    const { calls } = tab({
      "/api/v1/availabilities": json(
        { items: [{ ...repeated, label: "night", startsAt: "2026-10-11T10:00:00.000Z", endsAt: "2026-10-11T14:00:00.000Z" }, { ...manual, label: null, startsAt: "2026-10-11T11:00:00.000Z", endsAt: "2026-10-11T13:00:00.000Z" }], nextCursor: null },
      ),
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const night = await cell("10/11（日） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/11（日） 夜 ここ暇が2つ。押すと選べる"));
    await userEvent.click(night);
    const sheet = screen.getByRole("dialog", { name: "10/11（日） 夜" });
    const rows = within(sheet).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual(["19:00〜23:00くり返しこの日だけ外す", "20:00〜22:00取り消す"]);
    await userEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${SLOT_ID}`)).toHaveLength(1));
  });

  it("2つ以上のマスのシートで失敗したら、シートの上に重ねた結果の帯に静かな文言を出す（後ろの画面に隠さない。T-56 M-09）", async () => {
    tab({
      "/api/v1/availabilities": json({ items: [manual, { ...manual, id: NEW_ID, label: null, startsAt: "2026-10-10T11:00:00.000Z" }], nextCursor: null }),
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Response(null, { status: 503 }),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/10（土） 夜 ここ暇が2つ。押すと選べる"));
    await userEvent.click(night);
    const sheet = screen.getByRole("dialog", { name: "10/10（土） 夜" });
    await userEvent.click(within(sheet).getAllByRole("button", { name: "取り消す" })[0] as HTMLElement);
    const status = screen.getByTestId("result-band");
    await waitFor(() => expect(status).toHaveTextContent("変更できませんでした。もう一度お試しください。"));
    // 帯はシートの後ろの #root の外（body の直下）に出る
    expect(status.parentElement).toBe(document.body);
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(2);
  });

  it("シートの枠を全部取り消すと閉じ、「取り消す」で戻してもシートは開き直さない", async () => {
    const second = { ...manual, id: NEW_ID, label: null, startsAt: "2026-10-10T11:00:00.000Z" };
    let server = [manual, second];
    const remove = (id: string) => () => {
      server = server.filter((i) => i.id !== id);
      return new Response(null, { status: 204 });
    };
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) => {
        if (init.method !== "POST") return json({ items: server, nextCursor: null })();
        server = [...server, second];
        return json(second, 201)();
      },
      [`/api/v1/availabilities/${SLOT_ID}`]: remove(SLOT_ID),
      [`/api/v1/availabilities/${NEW_ID}`]: remove(NEW_ID),
    });
    renderApp();
    const night = await cell("10/10（土） 夜");
    await waitFor(() => expect(night).toHaveAccessibleName("10/10（土） 夜 ここ暇が2つ。押すと選べる"));
    await userEvent.click(night);
    const sheet = screen.getByRole("dialog", { name: "10/10（土） 夜" });
    await userEvent.click(within(sheet).getAllByRole("button", { name: "取り消す" })[0] as HTMLElement);
    // 1つ残っている間はシートのまま。結果の一文と「取り消す」はシートの上に重ねた結果の帯
    expect(await within(screen.getByTestId("result-band")).findByText("10/10（土） 夜のここ暇を取り消しました")).toBeVisible();
    await userEvent.click(within(within(sheet).getByRole("listitem")).getByRole("button"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(await undoOf("10/10（土） 夜のここ暇を取り消しました"));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/availabilities")).toHaveLength(1));
    expect(await screen.findByText("元に戻しました")).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("続けて2つのマスを押し、あとの方が失敗しても、その操作の分だけ戻す（先に作った本物の枠は残る）", async () => {
    const createdA = { ...manual, id: NEW_ID, startsAt: "2026-10-11T10:00:00.000Z", endsAt: "2026-10-11T14:00:00.000Z" };
    let serverItems: unknown[] = [manual];
    let answerA: (r: Response) => void = () => {};
    let answerB: (r: Response) => void = () => {};
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) =>
        init.method === "POST" ? new Promise<Response>((resolve) => (answerA = resolve)) : json({ items: serverItems, nextCursor: null })(),
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Promise<Response>((resolve) => (answerB = resolve)),
      [`/api/v1/availabilities/${NEW_ID}`]: () => new Response(null, { status: 204 }),
    });
    const reads = () => calls.filter((c) => c.url.split("?")[0] === "/api/v1/availabilities" && (c.init.method ?? "GET") === "GET").length;
    renderApp();
    await waitFor(() => expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(cellNow("10/11（日） 夜"));
    await userEvent.click(cellNow("10/10（土） 夜"));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${SLOT_ID}`)).toHaveLength(1));
    const before = reads();
    serverItems = [manual, createdA];
    answerA(json(createdA, 201)());
    expect(await screen.findByText("10/11（日） 夜をここ暇にしました")).toBeVisible();
    // 送っている操作が残っている間は読み直さない
    expect(reads()).toBe(before);
    answerB(new Response(null, { status: 503 }));
    expect(await screen.findByText("変更できませんでした。もう一度お試しください。")).toBeVisible();
    expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "true");
    expect(cellNow("10/11（日） 夜")).toHaveAttribute("aria-pressed", "true");
    // 先に作った枠は応答の id で消せる
    await userEvent.click(cellNow("10/11（日） 夜"));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${NEW_ID}`)).toHaveLength(1));
    expect(calls.some((c) => c.url.includes("draft-"))).toBe(false);
  });

  it("5xx のあとに同じマスを押し直すと、間にほかのマスを作っても同じ Idempotency-Key", async () => {
    let first = true;
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) => {
        if (init.method !== "POST") return empty();
        const body = JSON.parse(String(init.body)) as { date: string };
        if (body.date === "2026-10-10" && first) {
          first = false;
          return new Response(null, { status: 503 });
        }
        return json({ ...manual, id: body.date === "2026-10-10" ? NEW_ID : SLOT_ID }, 201)();
      },
    });
    renderApp();
    await userEvent.click(await cell("10/10（土） 夜"));
    expect(await screen.findByText(/通信状態を確認して/)).toBeVisible();
    await userEvent.click(cellNow("10/12（月） 夜"));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/availabilities")).toHaveLength(2));
    await waitFor(() => expect(cellNow("10/10（土） 夜")).toHaveAttribute("aria-pressed", "false"));
    await userEvent.click(cellNow("10/10（土） 夜"));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/availabilities")).toHaveLength(3));
    const keyOf = (i: number) => new Headers(sent(calls, "POST", "/api/v1/availabilities")[i]?.init.headers).get("Idempotency-Key");
    expect(keyOf(2)).toBe(keyOf(0));
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("終わりが過ぎた枠を取り消したときは、作り直せないので「取り消す」を出さない", async () => {
    // 東京の 16:30。今日の昼（11:00〜15:00）は終わっている
    vi.setSystemTime(new Date("2026-10-10T07:30:00Z"));
    const ended = { ...manual, label: "day", startsAt: "2026-10-10T02:00:00.000Z", endsAt: "2026-10-10T06:00:00.000Z" };
    tab({
      "/api/v1/availabilities": json({ items: [ended], nextCursor: null }),
      [`/api/v1/availabilities/${SLOT_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const day = await cell("10/10（土） 昼");
    await waitFor(() => expect(day).toHaveAttribute("aria-pressed", "true"));
    await userEvent.click(day);
    const message = await screen.findByText("10/10（土） 昼のここ暇を取り消しました");
    expect(within(message.parentElement as HTMLElement).queryByRole("button", { name: "取り消す" })).toBeNull();
  });

  it("「取り消す」は続けて押しても1回だけ送る。戻したら、押したマスにフォーカスを戻す", async () => {
    let answer: (r: Response) => void = () => {};
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) => (init.method === "POST" ? json(createdNight, 201)() : empty()),
      [`/api/v1/availabilities/${NEW_ID}`]: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    renderApp();
    await userEvent.click(await cell("10/10（土） 夜"));
    const undo = await undoOf("10/10（土） 夜をここ暇にしました");
    await userEvent.click(undo);
    await userEvent.click(undo);
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${NEW_ID}`)).toHaveLength(1));
    expect(undo).toHaveAttribute("aria-disabled", "true");
    answer(new Response(null, { status: 204 }));
    expect(await screen.findByText("元に戻しました")).toBeVisible();
    expect(sent(calls, "DELETE", `/api/v1/availabilities/${NEW_ID}`)).toHaveLength(1);
    expect(cellNow("10/10（土） 夜")).toHaveFocus();
  });
});

describe("1行のリンク", () => {
  it("「時間を細かく決めて入れる」：日付・開始・終了で作る（終了が開始以前なら翌日）。作ったら閉じて「取り消す」を出す", async () => {
    const custom = { ...manual, id: NEW_ID, label: null, startsAt: "2026-10-10T13:00:00.000Z", endsAt: "2026-10-10T17:00:00.000Z" };
    const { calls } = tab({
      "/api/v1/availabilities": ({ init }) => (init.method === "POST" ? json(custom, 201)() : empty()),
      [`/api/v1/availabilities/${NEW_ID}`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /^時間を細かく決めて入れる/ }));
    const sheet = screen.getByRole("dialog", { name: "時間を決めて入れる" });
    await userEvent.clear(within(sheet).getByLabelText("開始"));
    await userEvent.type(within(sheet).getByLabelText("開始"), "22:00");
    await userEvent.clear(within(sheet).getByLabelText("終了"));
    await userEvent.type(within(sheet).getByLabelText("終了"), "02:00");
    await userEvent.click(within(sheet).getByRole("button", { name: "入れる" }));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/availabilities")).toHaveLength(1));
    expect(JSON.parse(String(sent(calls, "POST", "/api/v1/availabilities")[0]?.init.body))).toEqual({
      startsAt: "2026-10-10T13:00:00.000Z",
      endsAt: "2026-10-10T17:00:00.000Z",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(await undoOf("10/10（土） 22:00〜10/11（日） 02:00を入れました"));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/availabilities/${NEW_ID}`)).toHaveLength(1));
    expect(await screen.findByText("元に戻しました")).toBeVisible();
  });

  it("「時間を細かく決めて入れる」で作れなければ、シートに静かな文言", async () => {
    tab({ "/api/v1/availabilities": ({ init }) => (init.method === "POST" ? json({}, 400)() : empty()) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /^時間を細かく決めて入れる/ }));
    const sheet = screen.getByRole("dialog", { name: "時間を決めて入れる" });
    await userEvent.click(within(sheet).getByRole("button", { name: "入れる" }));
    const message = await within(sheet).findByText(/過去・60日より先/);
    expect(message.className).not.toMatch(/red|rose/);
  });

  it("「くり返し」：要約と数を出し、シートで一覧・削除・外した日を戻す・追加ができる", async () => {
    const rule = { id: RULE_ID, weekday: 5, start: "11:00", end: "15:00", label: "day", timezone: "Asia/Tokyo", exceptions: ["2026-10-16"], createdAt: "2026-10-01T00:00:00.000Z" };
    const { calls } = tab({
      "/api/v1/recurrence-rules": ({ init }) =>
        init.method === "POST" ? json({ ...rule, id: NEW_ID, weekday: 6, label: "night", start: "19:00", end: "23:00", exceptions: [] }, 201)() : json({ items: [rule], nextCursor: null })(),
      [`/api/v1/recurrence-rules/${RULE_ID}/exceptions/2026-10-16`]: () => new Response(null, { status: 204 }),
    });
    renderApp();
    const link = await screen.findByRole("button", { name: /^くり返し/ });
    await waitFor(() => expect(link).toHaveTextContent("くり返し毎週金 昼1つ ›"));
    await userEvent.click(link);
    const sheet = screen.getByRole("dialog", { name: "くり返し" });
    expect(await within(sheet).findByText("毎週金曜 昼 11:00〜15:00")).toBeVisible();
    await userEvent.click(within(sheet).getByRole("button", { name: "戻す" }));
    await waitFor(() => expect(sent(calls, "DELETE", `/api/v1/recurrence-rules/${RULE_ID}/exceptions/2026-10-16`)).toHaveLength(1));
    await userEvent.click(within(sheet).getByRole("button", { name: "＋ くり返しを追加する" }));
    const add = screen.getByRole("dialog", { name: "くり返しを追加" });
    await userEvent.click(within(add).getByRole("button", { name: "くり返しを追加" }));
    await waitFor(() => expect(sent(calls, "POST", "/api/v1/recurrence-rules")).toHaveLength(1));
    expect(JSON.parse(String(sent(calls, "POST", "/api/v1/recurrence-rules")[0]?.init.body))).toEqual({ weekday: 6, preset: "night" });
    expect(await screen.findByRole("dialog", { name: "くり返し" })).toBeVisible();
  });

  it("今の「自分のここ暇」の縦の一覧は出さない", async () => {
    tab();
    renderApp();
    await cell("10/10（土） 夜");
    expect(screen.queryByRole("list", { name: "自分のここ暇" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ここ暇を追加" })).toBeNull();
  });
});
