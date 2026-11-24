import { QueryClient } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { meetMomentDots, meetMomentOffset, meetMomentWith } from "../invitations/MeetMoment";
import {
  MEET_MOMENT_SEEN_KEY,
  MEET_MOMENT_SEEN_MAX,
  clearMeetMomentSeen,
  hasSeenMeetMoment,
  markMeetMomentSeen,
} from "../invitations/meetMomentSeen";
import { json, mockFetch, renderApp, tokenBody } from "../test/helpers";

// T-43 成立の演出（docs/specs/T-43-meet-moment.md「テスト計画」）
// 時計は 2026-10-10T00:00:00Z（東京は土曜 09:00）

const ME_ID = "11111111-1111-4111-8111-111111111111";
const FRIEND_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "55555555-5555-4555-8555-555555555555";
const MEETUP_ID = "66666666-6666-4666-8666-666666666666";
const BROADCAST_ID = "77777777-7777-4777-8777-777777777777";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (id: string, displayName: string | null, withdrawn = false) => ({ id, displayName, avatarUrl: null, withdrawn });
const friend = person(FRIEND_ID, "あき");
const me = json({ id: ME_ID, displayName: "はる", avatarUrl: null });

const invite = (over: Record<string, unknown> = {}) => ({
  id: INVITE_ID,
  kind: "asobo",
  direction: "received",
  counterpart: friend,
  status: "pending",
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  area: "渋谷",
  message: null,
  url: null,
  linkPreview: null,
  expiresAt: "2026-10-10T10:00:00.000Z",
  counterProposal: null,
  meetupId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

const meetup = (over: Record<string, unknown> = {}) => ({
  id: MEETUP_ID,
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  status: "confirmed",
  participants: [friend],
  area: "渋谷",
  message: null,
  url: null,
  linkPreview: null,
  directInviteId: INVITE_ID,
  broadcastId: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  ...over,
});

const broadcast = (over: Record<string, unknown> = {}) => ({
  id: BROADCAST_ID,
  direction: "sent",
  owner: person(ME_ID, "はる"),
  status: "open",
  startsAt: "2026-10-10T10:00:00.000Z",
  endsAt: "2026-10-10T14:00:00.000Z",
  area: null,
  message: null,
  url: null,
  linkPreview: null,
  expiresAt: "2026-10-10T10:00:00.000Z",
  createdAt: "2026-10-10T00:00:00.000Z",
  recipients: [1, 2, 3].map((n) => person(uuid(n), `友${n}`)),
  responseCount: 3,
  respondedByMe: null,
  meetupId: null,
  ...over,
});

const base = {
  "/api/v1/auth/refresh": json(tokenBody()),
  "/api/v1/me": me,
  "/api/v1/direct-invites": json({ items: [], nextCursor: null }),
  "/api/v1/broadcasts": json({ items: [], nextCursor: null }),
  "/api/v1/meetups": json({ items: [], nextCursor: null }),
};

const open = (path: string, routes: Parameters<typeof mockFetch>[0]) => {
  window.history.replaceState(null, "", path);
  return mockFetch({ ...base, ...routes });
};

const moment = () => screen.queryByRole("region", { name: "決まった！" });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  tokenStore.clear();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("誘いの「行く」", () => {
  it("押すと、ふたつの丸・「決まった！」・日時・相手・.ics を出し、この予定を見たと端末に記録する", async () => {
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [json(invite()), json(invite({ status: "confirmed", meetupId: MEETUP_ID }))],
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: json(invite({ status: "confirmed", meetupId: MEETUP_ID })),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup()),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "行く" }));
    const region = await screen.findByRole("region", { name: "決まった！" });
    expect(within(region).getByRole("heading", { name: "決まった！" })).toBeVisible();
    expect(within(region).getByText("10/10（土） 19:00〜23:00")).toBeVisible();
    expect(within(region).getByText("エリア：渋谷")).toBeVisible();
    expect(within(region).getByText("あきと会える")).toBeVisible();
    expect(within(region).getByRole("button", { name: "カレンダーに追加（.ics）" })).toBeVisible();
    // 丸は自分（左）と相手。動きの前の位置は外側から、止まった形は青緑（meet）
    const dots = region.querySelectorAll("[data-testid=meet-dot]");
    expect([...dots].map((d) => d.textContent)).toEqual(["は", "あ"]);
    expect(dots[0]).toHaveClass("kh-meet-dot", "bg-meet", "text-on-meet");
    expect((dots[0] as HTMLElement).style.getPropertyValue("--kh-meet-from")).toBe("-74px");
    expect((dots[1] as HTMLElement).style.getPropertyValue("--kh-meet-from")).toBe("74px");
    // 時間の欄は演出の中にだけ出す（二重に出さない）
    expect(screen.getAllByText("10/10（土） 19:00〜23:00")).toHaveLength(1);
    // 既存の「成立した予定を見る」は1つだけ（演出の中に重ねない）
    expect(screen.getAllByRole("link", { name: "成立した予定を見る" })).toHaveLength(1);
    await waitFor(() => expect(hasSeenMeetMoment(MEETUP_ID)).toBe(true));
  });

  it("「今回は難しい」では演出を出さず、予定も読まない", async () => {
    const { calls } = open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [json(invite()), json(invite({ status: "declined" }))],
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: json(invite({ status: "declined" })),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "今回は難しい" }));
    expect(await screen.findByText("今回は難しいと返しました")).toBeVisible();
    expect(moment()).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/v1/meetups/"))).toBe(false);
    expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).toBeNull();
  });

  it("送れなかった（楽観的に成立を出した間も）演出は流さない", async () => {
    let fail: (r: Response) => void = () => {};
    const { calls } = open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite()),
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: () => new Promise<Response>((resolve) => (fail = resolve)),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "行く" }));
    expect(moment()).toBeNull();
    fail(new Response(null, { status: 503 }));
    expect(await screen.findByText("送れませんでした。もう一度お試しください")).toBeVisible();
    expect(moment()).toBeNull();
    expect(calls.some((c) => c.url.includes("/api/v1/meetups/"))).toBe(false);
  });
  it("「この時間なら」が返った送信の誘いで決めると、予定の（代わりの）時間で流し、最初の時間は出さない", async () => {
    const counterProposal = { startsAt: "2026-10-10T11:00:00.000Z", endsAt: "2026-10-10T14:00:00.000Z" };
    const sent = { direction: "sent", status: "counter_proposed", counterProposal };
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [
        json(invite(sent)),
        json(invite({ ...sent, status: "confirmed", meetupId: MEETUP_ID })),
      ],
      [`/api/v1/direct-invites/${INVITE_ID}/decide`]: json(invite({ ...sent, status: "confirmed", meetupId: MEETUP_ID })),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup(counterProposal)),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "20:00〜で決める" }));
    const region = await screen.findByRole("region", { name: "決まった！" });
    expect(within(region).getByText("10/10（土） 20:00〜23:00")).toBeVisible();
    expect(screen.queryByText(/最初の時間/)).toBeNull();
    expect(screen.queryByText("10/10（土） 19:00〜23:00")).toBeNull();
    await waitFor(() => expect(hasSeenMeetMoment(MEETUP_ID)).toBe(true));
  });
});

describe("記録するのは、参加者として読めて流したときだけ", () => {
  it.each([
    ["見つからない（参加者でない）", 404, "この予定は見つかりませんでした。"],
    ["読めなかった（通信・サーバー）", 503, "読み込めませんでした。もう一度お試しください"],
  ])("%s予定は記録せず、次に読めたときに流す", async (_label, status, text) => {
    open(`/meetups/${MEETUP_ID}`, {
      [`/api/v1/meetups/${MEETUP_ID}`]: [json({ error: { code: "x", message: "x" } }, status), json(meetup())],
    });
    const first = renderApp();
    expect(await screen.findByText(text)).toBeVisible();
    expect(moment()).toBeNull();
    expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).toBeNull();
    first.unmount();

    renderApp();
    expect(await screen.findByRole("region", { name: "決まった！" })).toBeVisible();
    await waitFor(() => expect(hasSeenMeetMoment(MEETUP_ID)).toBe(true));
  });
});

describe("誘った側（成立を知って最初に開いた1回だけ）", () => {
  it("成立した送信の誘いを開くと1回だけ流し、2回めからは今までの表示", async () => {
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite({ direction: "sent", status: "confirmed", meetupId: MEETUP_ID })),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup()),
    });
    const first = renderApp();
    expect(await screen.findByRole("region", { name: "決まった！" })).toBeVisible();
    await waitFor(() => expect(hasSeenMeetMoment(MEETUP_ID)).toBe(true));
    first.unmount();

    renderApp();
    expect(await screen.findByText("10/10（土） 19:00〜23:00")).toBeVisible();
    expect(moment()).toBeNull();
  });

  it("お知らせから成立した予定を開くと、時間の欄の代わりに演出を出し、.ics は今までの1つだけ", async () => {
    open(`/meetups/${MEETUP_ID}`, { [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup()) });
    const first = renderApp();
    const region = await screen.findByRole("region", { name: "決まった！" });
    expect(within(region).getByText("あきと会える")).toBeVisible();
    expect(screen.getAllByRole("button", { name: "カレンダーに追加（.ics）" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "やっぱり難しい" })).toBeVisible();
    first.unmount();

    // 同じ予定は、誘いの詳細でも予定の詳細でも、もう流さない
    renderApp();
    expect(await screen.findByText("10/10（土） 19:00〜23:00")).toBeVisible();
    expect(moment()).toBeNull();
  });

  it("「やっぱり難しい」を押すと、演出を消して静かな表示に戻す", async () => {
    open(`/meetups/${MEETUP_ID}`, {
      [`/api/v1/meetups/${MEETUP_ID}`]: [json(meetup()), json(meetup({ status: "cancelled" }))],
      [`/api/v1/meetups/${MEETUP_ID}/cancel`]: json(meetup({ status: "cancelled" })),
    });
    renderApp();
    await screen.findByRole("region", { name: "決まった！" });
    await userEvent.click(screen.getByRole("button", { name: "やっぱり難しい" }));
    expect(await screen.findByText("やっぱり難しくなりました")).toBeVisible();
    expect(moment()).toBeNull();
  });

  it.each([
    ["取り消された予定", { status: "cancelled" }],
    ["終わった予定", { startsAt: "2026-10-09T10:00:00.000Z", endsAt: "2026-10-09T12:00:00.000Z" }],
  ])("%sでは流さない", async (_label, over) => {
    open(`/meetups/${MEETUP_ID}`, { [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup(over)) });
    renderApp();
    expect(await screen.findByRole("heading", { name: "成立した予定" })).toBeVisible();
    await screen.findByText(/^10\/(9|10)（.）/);
    expect(moment()).toBeNull();
    // 流さない予定は端末に記録しない
    expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).toBeNull();
  });
});

describe("募集で決めたとき（3人以上）", () => {
  it("決めると、自分と参加者の丸を並べ、名前は「a・bほかn人」", async () => {
    const others = [1, 2, 3].map((n) => person(uuid(n), `友${n}`));
    open(`/broadcasts/${BROADCAST_ID}`, {
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: [json(broadcast()), json(broadcast({ status: "decided", meetupId: MEETUP_ID }))],
      [`/api/v1/broadcasts/${BROADCAST_ID}/decide`]: json(broadcast({ status: "decided", meetupId: MEETUP_ID })),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup({ participants: others, directInviteId: null, broadcastId: BROADCAST_ID })),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "決める" }));
    const region = await screen.findByRole("region", { name: "決まった！" });
    expect(within(region).getByText("友1・友2ほか1人と会える")).toBeVisible();
    expect([...region.querySelectorAll("[data-testid=meet-dot]")].map((d) => d.textContent)).toEqual(["は", "友", "友", "友"]);
    expect(screen.getAllByRole("link", { name: "成立した予定を見る" })).toHaveLength(1);
  });

  it("宛先の人が、決まった募集を最初に開いたときも流す", async () => {
    open(`/broadcasts/${BROADCAST_ID}`, {
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: json(
        broadcast({ direction: "received", owner: friend, recipients: null, responseCount: null, respondedByMe: true, status: "decided", meetupId: MEETUP_ID }),
      ),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup({ participants: [friend, person(uuid(2), "そら")], broadcastId: BROADCAST_ID })),
    });
    renderApp();
    const region = await screen.findByRole("region", { name: "決まった！" });
    expect(within(region).getByText("あき・そらと会える")).toBeVisible();
  });
});

/** 動きを止める設定（matches）を差し替える。PC の幅の問い合わせは false */
function stubReducedMotion(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" ? matches : false, media: q, addEventListener: () => {}, removeEventListener: () => {} })),
  );
}

/** 詳細のシートの見出しのバッジ */
const badge = () => screen.getByRole("dialog").querySelector<HTMLElement>("[data-tone]");
/** 返答・決定のボタン群を包む Collapse */
const collapseOf = (name: string) => screen.getByRole("button", { name }).closest(".kh-collapse");
const deferred = () => {
  let resolve: (r: Response) => void = () => {};
  const route = () => new Promise<Response>((r) => (resolve = r));
  return { route, respond: (body: unknown, status = 200) => resolve(new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) };
};

describe("成立の瞬間に足す部分（docs/specs/T-56-motion.md「M-04」）", () => {
  it("「行く」を押すと、楽観的更新のときに返答のボタン群が Collapse の閉じる側になり、バッジに kh-badge-pop が1回付く", async () => {
    stubReducedMotion(false);
    const responses = deferred();
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [json(invite()), json(invite({ status: "confirmed", meetupId: MEETUP_ID }))],
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: responses.route,
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup()),
    });
    renderApp();
    await screen.findByRole("button", { name: "行く" });
    expect(badge()).not.toHaveClass("animate-kh-badge-pop");
    const group = collapseOf("行く");
    expect(group).not.toHaveAttribute("data-closed");
    await userEvent.click(screen.getByRole("button", { name: "行く" }));
    // 応答を待たずに（楽観的更新のとき）
    await waitFor(() => expect(badge()).toHaveClass("animate-kh-badge-pop"));
    expect(badge()).toHaveAttribute("data-tone", "meet");
    expect(group).toHaveAttribute("data-closed");
    expect(group?.querySelector(".kh-collapse-shrink")).not.toBeNull();
    responses.respond(invite({ status: "confirmed", meetupId: MEETUP_ID }));
    await screen.findByRole("region", { name: "決まった！" });
    // 閉じ終わるとボタン群は消える。ぽんの印は1つ（同じ要素のまま）
    await waitFor(() => expect(screen.queryByRole("button", { name: "行く" })).toBeNull());
    expect(screen.getByRole("dialog").querySelectorAll(".animate-kh-badge-pop")).toHaveLength(1);
  });

  it("送れなかったとき（閉じる動きより早く失敗しても）は、ボタン群が戻って消えず、静かな文言が出て、バッジは動かない", async () => {
    stubReducedMotion(false);
    const responses = deferred();
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite()),
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: responses.route,
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "行く" }));
    await waitFor(() => expect(collapseOf("行く")).toHaveAttribute("data-closed"));
    responses.respond(null, 503);
    expect(await screen.findByText("送れませんでした。もう一度お試しください")).toBeVisible();
    await waitFor(() => expect(collapseOf("行く")).not.toHaveAttribute("data-closed"));
    expect(badge()).not.toHaveClass("animate-kh-badge-pop");
    expect(badge()).not.toHaveAttribute("data-tone", "meet");
    // 閉じる動きの保険のタイマー（160＋50ms）が過ぎても、ボタン群は消えない
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.getByRole("button", { name: "行く" })).toBeVisible();
    expect(screen.getByRole("button", { name: "今回は難しい" })).toBeVisible();
  });

  it("「今回は難しい」では、ボタン群は同じ静かな動きで消え、バッジは動かない", async () => {
    stubReducedMotion(false);
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [json(invite()), json(invite({ status: "declined" }))],
      [`/api/v1/direct-invites/${INVITE_ID}/responses`]: json(invite({ status: "declined" })),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "今回は難しい" }));
    expect(await screen.findByText("今回は難しいと返しました")).toBeVisible();
    expect(badge()).not.toHaveClass("animate-kh-badge-pop");
    await waitFor(() => expect(screen.queryByRole("button", { name: "今回は難しい" })).toBeNull());
  });

  it("詳細を開いたまま、取り直しで相手の操作により成立に変わったときは、バッジに kh-badge-pop が付かない", async () => {
    stubReducedMotion(false);
    // 演出はもう見た（演出の条件に当たらない）
    markMeetMomentSeen(MEETUP_ID);
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: [
        json(invite({ direction: "sent" })),
        json(invite({ direction: "sent", status: "confirmed", meetupId: MEETUP_ID })),
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderApp(client);
    await screen.findByRole("dialog", { name: "あきさんへの誘い" });
    await waitFor(() => expect(badge()).not.toBeNull());
    await act(() => client.refetchQueries());
    await waitFor(() => expect(badge()).toHaveAttribute("data-tone", "meet"));
    expect(badge()).not.toHaveClass("animate-kh-badge-pop");
    expect(moment()).toBeNull();
  });

  it("「成立した予定を見る」は meet の塗りのボタン（bg-meet）で1つだけ（誘いの詳細）", async () => {
    open(`/invites/${INVITE_ID}`, {
      [`/api/v1/direct-invites/${INVITE_ID}`]: json(invite({ status: "confirmed", meetupId: MEETUP_ID })),
      [`/api/v1/meetups/${MEETUP_ID}`]: json(meetup()),
    });
    renderApp();
    const links = await screen.findAllByRole("link", { name: "成立した予定を見る" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", `/meetups/${MEETUP_ID}`);
    expect(links[0]?.className).toContain("bg-meet");
    expect(links[0]?.className).toContain("w-full");
    expect(links[0]?.className).not.toMatch(/(?<!no-)underline|text-action/);
    // 演出が流れる最初の描画では、バッジがぽんとする
    await screen.findByRole("region", { name: "決まった！" });
    expect(badge()).toHaveClass("animate-kh-badge-pop");
  });

  it("募集で自分が決めると、バッジがぽんとし、「成立した予定を見る」は meet の塗りのボタンで1つだけ", async () => {
    markMeetMomentSeen(MEETUP_ID);
    open(`/broadcasts/${BROADCAST_ID}`, {
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: [json(broadcast()), json(broadcast({ status: "decided", meetupId: MEETUP_ID }))],
      [`/api/v1/broadcasts/${BROADCAST_ID}/decide`]: json(broadcast({ status: "decided", meetupId: MEETUP_ID })),
    });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "決める" }));
    const links = await screen.findAllByRole("link", { name: "成立した予定を見る" });
    expect(links).toHaveLength(1);
    expect(links[0]?.className).toContain("bg-meet");
    expect(badge()).toHaveClass("animate-kh-badge-pop");
  });

  it("募集の宛先の人で予定の参加者でない人には、ぽんも予定を見るボタンも出ない", async () => {
    open(`/broadcasts/${BROADCAST_ID}`, {
      [`/api/v1/broadcasts/${BROADCAST_ID}`]: json(
        broadcast({ direction: "received", owner: friend, recipients: null, responseCount: null, respondedByMe: false, status: "closed", meetupId: null }),
      ),
    });
    renderApp();
    await screen.findByRole("dialog", { name: "あきさんの募集" });
    await waitFor(() => expect(badge()).not.toBeNull());
    expect(badge()).not.toHaveClass("animate-kh-badge-pop");
    expect(screen.queryByRole("link", { name: "成立した予定を見る" })).toBeNull();
  });

  it("一覧のカードのバッジは動かさない（ぽんを付けるのは詳細だけ）", () => {
    const card = readFileSync(join(import.meta.dirname, "../ui/InviteCard.tsx"), "utf8");
    expect(card).not.toMatch(/\bpop\b|kh-badge-pop/);
  });
});

describe("丸の並べ方と名前", () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => person(uuid(i + 1), `友${i + 1}`));

  it("自分を左に、合わせて4つまで。5人以上は最後を「+n」にする", () => {
    expect(meetMomentDots("はる", people(1)).map((d) => d.label)).toEqual(["は", "友"]);
    expect(meetMomentDots("はる", people(3)).map((d) => d.label)).toEqual(["は", "友", "友", "友"]);
    expect(meetMomentDots("はる", people(4)).map((d) => d.label)).toEqual(["は", "友", "友", "+2"]);
    expect(meetMomentDots("はる", people(9)).map((d) => d.label)).toEqual(["は", "友", "友", "+7"]);
    // 名前がない・読めない・退会した人は「？」
    expect(meetMomentDots(null, [person(uuid(1), null), person(uuid(2), "あき", true)]).map((d) => d.label)).toEqual(["？", "？", "？"]);
  });

  it("名前は2人まで並べ、3人からは「ほかn人」。退会した人は「退会したユーザー」", () => {
    expect(meetMomentWith(people(1))).toBe("友1");
    expect(meetMomentWith(people(2))).toBe("友1・友2");
    expect(meetMomentWith(people(5))).toBe("友1・友2ほか3人");
    expect(meetMomentWith([person(uuid(1), null), person(uuid(2), "x", true)])).toBe("名前未設定の友達・退会したユーザー");
  });

  it("寄ってくる前のずれは真ん中から外へ対称で、丸が増えるほど小さい", () => {
    expect([0, 1].map((i) => meetMomentOffset(i, 2))).toEqual([-74, 74]);
    expect([0, 1, 2].map((i) => meetMomentOffset(i, 3))).toEqual([-64, 0, 64]);
    expect([0, 1, 2, 3].map((i) => meetMomentOffset(i, 4))).toEqual([-60, -20, 20, 60]);
  });
});

describe("見た予定の端末の記録", () => {
  it("予定の ID だけを、新しい順に50件まで置く", () => {
    for (let i = 0; i < MEET_MOMENT_SEEN_MAX + 5; i++) markMeetMomentSeen(uuid(i));
    const saved = JSON.parse(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY) ?? "[]") as string[];
    expect(saved).toHaveLength(MEET_MOMENT_SEEN_MAX);
    expect(hasSeenMeetMoment(uuid(0))).toBe(false);
    expect(hasSeenMeetMoment(uuid(MEET_MOMENT_SEEN_MAX + 4))).toBe(true);
    // 同じ ID は重ねない
    markMeetMomentSeen(uuid(MEET_MOMENT_SEEN_MAX + 4));
    expect(JSON.parse(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY) ?? "[]")).toHaveLength(MEET_MOMENT_SEEN_MAX);
    // ID の形でないものは置かない
    markMeetMomentSeen("<script>");
    expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).not.toContain("script");
  });

  it("壊れた値・読めない・書けないときは「見ていない」として扱い、落ちない", () => {
    window.localStorage.setItem(MEET_MOMENT_SEEN_KEY, "{not json");
    expect(hasSeenMeetMoment(MEETUP_ID)).toBe(false);
    window.localStorage.setItem(MEET_MOMENT_SEEN_KEY, JSON.stringify({ id: MEETUP_ID }));
    expect(hasSeenMeetMoment(MEETUP_ID)).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(hasSeenMeetMoment(MEETUP_ID)).toBe(false);
    expect(() => markMeetMomentSeen(MEETUP_ID)).not.toThrow();
    expect(() => clearMeetMomentSeen()).not.toThrow();
  });

  it("ログアウトで記録を消す", async () => {
    markMeetMomentSeen(MEETUP_ID);
    window.history.replaceState(null, "", "/settings/account");
    mockFetch({ ...base, "/api/v1/auth/logout": () => new Response(null, { status: 204 }) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "ログアウト" }));
    await waitFor(() => expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).toBeNull());
  });

  it("アプリを閉じている間にログインが切れていたら、起動したときに記録を消す", async () => {
    markMeetMomentSeen(MEETUP_ID);
    window.history.replaceState(null, "", "/");
    mockFetch({ ...base, "/api/v1/auth/refresh": () => new Response(null, { status: 401 }) });
    renderApp();
    await waitFor(() => expect(window.localStorage.getItem(MEET_MOMENT_SEEN_KEY)).toBeNull());
  });
});

describe("プライバシー ポリシー", () => {
  it("10. に、見た予定の番号をブラウザのストレージに置くことを書く", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch(base);
    renderApp();
    expect(await screen.findByText(/演出を見た予定の番号（新しいものから50件まで）を、ブラウザのストレージに置きます/)).toBeVisible();
  });
});

describe("動きと色（index.css）", () => {
  const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf8");
  const block = (name: string) => css.slice(css.indexOf(`@keyframes ${name}`), css.indexOf("}\n}", css.indexOf(`@keyframes ${name}`)));

  it("動きは CSS のアニメーションだけで、prefers-reduced-motion では共通の決まりで止まる（止まった形が重なった青緑の丸）", () => {
    expect(css).toMatch(/\.kh-meet-dot\s*\{\s*animation: kh-meet-converge 1200ms/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\{\s*transition: none !important;\s*animation: none !important;/);
  });

  it("色は灯り（lamp）から成立（meet）のトークンだけで、色を直書きしない", () => {
    const converge = block("kh-meet-converge");
    expect(converge).toContain("var(--color-lamp)");
    expect(converge.trim().endsWith("var(--color-on-meet);")).toBe(true);
    for (const name of ["kh-meet-converge", "kh-meet-glow", "kh-meet-reveal"]) {
      expect(block(name)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
    }
  });
});
