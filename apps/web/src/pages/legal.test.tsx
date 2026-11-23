import { PLATFORM_RETENTION, RETENTION } from "@kokohima/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";
import { EFFECTIVE_DATE_LINE } from "./legal";

// プライバシー ポリシーと利用規約（docs/specs/T-19-privacy-terms.md「テスト計画」）

const LINK_ID = "11111111-1111-4111-8111-111111111111";
const lookupOk = json({ linkId: LINK_ID, inviter: { displayName: "あき", avatarUrl: null } });
const me = { id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null };
const CONSENT = "続けると利用規約とプライバシー ポリシーに同意したことになります";

beforeEach(() => {
  tokenStore.clear();
  document.title = "ここ暇";
});

afterEach(async () => {
  releaseChecking();
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PRIVACY_SECTIONS = [
  "1. 運営者と連絡先",
  "2. 預かる情報",
  "3. 使う目的",
  "4. ほかの利用者に見えるもの",
  "5. 外部の事業者に任せること（委託）",
  "6. 第三者への提供",
  "7. 外国での取り扱い",
  "8. 保存する期間",
  "9. 安全のための取り組み",
  "10. Cookie と、端末に置くもの",
  "11. Google から受け取った情報の扱い",
  "12. 開示・訂正・削除などの求め",
  "13. 子どもの利用",
  "14. このポリシーの変更",
];
const TERMS_SECTIONS = [
  "第1条（同意）",
  "第2条（使える人）",
  "第3条（アカウント）",
  "第4条（このサービスでできること）",
  "第5条（あなたが入力する内容）",
  "第6条（してはいけないこと）",
  "第7条（利用の停止）",
  "第8条（サービスの変更・中断・終了）",
  "第9条（退会）",
  "第10条（運営の責任）",
  "第11条（この規約の変更）",
  "第12条（連絡）",
  "第13条（準拠法と裁判所）",
];
const pages = [
  { path: "/privacy", title: "プライバシー ポリシー", section: "1. 運営者と連絡先", sections: PRIVACY_SECTIONS },
  { path: "/terms", title: "利用規約", section: "第1条（同意）", sections: TERMS_SECTIONS },
] as const;

// 確認中：テストの間は refresh を返さず、終わったら返す（refresh は同時に1つだけなので、返さないと次のテストが待ち続ける）
let releaseChecking: () => void = () => {};
const checking: Route = () =>
  new Promise<Response>((resolve) => {
    releaseChecking = () => resolve(new Response("{}", { status: 401 }));
  });
const networkError: Route = () => Promise.reject(new TypeError("Failed to fetch"));
const refreshStates: [string, Route][] = [
  ["確認中（checking）", checking],
  ["API に届かない（error）", networkError],
  ["ログインしていない（anonymous）", json({}, 401)],
  ["ログインしている（authenticated）", json(tokenBody())],
];

describe.each(pages)("$path", ({ path, title, section, sections }) => {
  it("見出し：h1 は SubScreen の題の1つだけ、h2 は文案のすべての節（順も同じ）", async () => {
    window.history.replaceState(null, "", path);
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([title]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(sections);
  });

  it("連絡先は mailto: のリンク", async () => {
    window.history.replaceState(null, "", path);
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: title, level: 1 });
    const links = screen.getAllByRole("link", { name: "ops@kokohima.app" });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link).toHaveAttribute("href", "mailto:ops@kokohima.app");
  });

  it.each(refreshStates)("%s でも本文を出し、別の画面に移らない", async (_, refresh) => {
    window.history.replaceState(null, "", path);
    const { calls } = mockFetch({ "/api/v1/auth/refresh": refresh });
    renderApp();
    expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(screen.getByRole("heading", { name: section, level: 2 })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(EFFECTIVE_DATE_LINE)).toBeVisible();
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.pathname).toBe(path);
    // AuthProvider の refresh のほかに、API を呼ばない
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/auth/refresh"]);
  });

  it("タブの題を変え、離れたら「ここ暇」に戻す", async () => {
    window.history.replaceState(null, "", "/login");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await userEvent.click(await screen.findByRole("link", { name: title }));
    expect(await screen.findByRole("heading", { name: title, level: 1 })).toBeVisible();
    expect(document.title).toBe(`${title}｜ここ暇`);
    // 「戻る」でログインの画面へ（アプリの中から開いたので1つ前に戻る）
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(window.location.pathname).toBe("/login");
    expect(document.title).toBe("ここ暇");
  });

  it("外から直接開いた「戻る」は / に移る（ログインしていなければログインの画面）", async () => {
    window.history.replaceState(null, "", path);
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: "戻る" }));
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
  });

  it("オフラインの帯が出ていても、本文を出す", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    window.history.replaceState(null, "", path);
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    expect(await screen.findByText(/オフラインです/)).toBeVisible();
    expect(screen.getByRole("heading", { name: section, level: 2 })).toBeVisible();
  });
});

describe("プライバシー ポリシーの本文", () => {
  it("連絡先・年齢・外へのリンクを出す", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    for (const link of screen.getAllByRole("link", { name: "ops@kokohima.app" })) {
      expect(link).toHaveAttribute("href", "mailto:ops@kokohima.app");
    }
    expect(screen.getByText("このサービスは13歳以上の人が使えます。")).toBeVisible();
    expect(screen.getByText("18歳未満の人は、保護者の同意を得てから使ってください。")).toBeVisible();
    const google = screen.getByRole("link", { name: "Google API サービスのユーザーデータに関するポリシー" });
    expect(google).toHaveAttribute("target", "_blank");
    expect(google).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("「8.」の保存期間は RETENTION の数をそのまま出す", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    const heading = await screen.findByRole("heading", { name: "8. 保存する期間", level: 2 });
    const text = heading.closest("section")?.textContent ?? "";
    const R = RETENTION;
    const expected = [
      `終わってから${R.availabilityAfterEndDays}日で消します（枠の長さは最長${R.availabilityMaxLengthDays}日なので、始まってから最長${R.availabilityMaxLengthDays + R.availabilityAfterEndDays}日です）`,
      `その日から${R.recurrenceExceptionDaysBefore + 1}日目に消します`,
      `が終わってから${R.invitationsDays}日で消します`,
      `作ってから${R.notificationsDays}日で消します`,
      `期限から${R.inviteLinksDays}日で消します`,
      `使えなくなってから${R.deadSessionsDays}日で消します`,
      `${R.dormantAfterDays}日アプリを開かなかったとき`,
      `${R.freeBusyCacheMinutes}分で消えます`,
      `取ってから${R.linkPreviewsDays}日を過ぎたら消します`,
      `処理してから${R.processedOutboxDays}日で消します`,
      `作ってから${R.staleNotificationOutboxDays}日で消します`,
      `${PLATFORM_RETENTION.deadLetterQueueDays}日で消えます`,
      `${R.idempotencyKeysHours}時間で消します`,
      `ログ：${PLATFORM_RETENTION.workersLogsDays}日で消えます`,
      `最大${PLATFORM_RETENTION.databaseRestoreDays}日は復元のための記録に残ります`,
    ];
    for (const e of expected) expect(text).toContain(e);
    // 今の値（T-17 の表）で読める文になっている
    expect(text).toContain("終わってから1日で消します（枠の長さは最長1日なので、始まってから最長2日です）");
  });
});

describe("リンクの置き場所", () => {
  it("ログインの画面：同意の1行と2つのリンク。チェックボックスはない", async () => {
    window.history.replaceState(null, "", "/login");
    const { calls } = mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    const line = await screen.findByText((_, el) => el?.tagName === "P" && el.textContent === CONSENT);
    expect(within(line).getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(within(line).getByRole("link", { name: "プライバシー ポリシー" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 同意の記録を送らない：ログインの画面の通信は refresh だけ
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/auth/refresh"]);
  });

  it("利用規約：第6条・第12条の連絡先と、第2条の年齢・保護者の同意", async () => {
    window.history.replaceState(null, "", "/terms");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    const article = (name: string) => screen.getByRole("heading", { name, level: 2 }).closest("section") as HTMLElement;
    await screen.findByRole("heading", { name: "利用規約", level: 1 });
    for (const name of ["第6条（してはいけないこと）", "第12条（連絡）"]) {
      expect(within(article(name)).getByRole("link", { name: "ops@kokohima.app" })).toHaveAttribute("href", "mailto:ops@kokohima.app");
    }
    expect(within(article("第2条（使える人）")).getByText("このサービスは、13歳以上の人が使えます。")).toBeVisible();
    expect(within(article("第2条（使える人）")).getByText("18歳未満の人は、保護者の同意を得てから使ってください。")).toBeVisible();
  });

  it("招待リンクの受け口：lookup が終わってからリンクを出し、開いて戻っても招待を続けられる", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": json({}, 401),
      "/api/v1/invite-links/lookup": async () => {
        await gate;
        return lookupOk();
      },
    });
    renderApp();
    expect(await screen.findByRole("status", { name: "読み込み中" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "プライバシー ポリシー" })).toBeNull();
    release();
    expect(await screen.findByText("あきさんから、ここ暇の友達の招待が届いています。")).toBeVisible();
    await userEvent.click(screen.getByRole("link", { name: "プライバシー ポリシー" }));
    expect(await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    expect(await screen.findByText("あきさんから、ここ暇の友達の招待が届いています。")).toBeVisible();
    expect(window.location.pathname).toBe("/invite");
    // 戻ったあとは、トークンを送らず招待 Cookie で lookup し直す
    const lookups = calls.filter((c) => c.url === "/api/v1/invite-links/lookup");
    expect(lookups.map((c) => JSON.parse(String(c.init.body)))).toEqual([{ token: "secret-invite-token" }, {}]);
  });

  it("招待リンクの受け口：ログインしていれば、同意の1行でなくリンクだけ", async () => {
    window.history.replaceState(null, "", "/invite");
    mockFetch({ "/api/v1/auth/refresh": json(tokenBody()), "/api/v1/invite-links/lookup": lookupOk });
    renderApp();
    expect(await screen.findByRole("button", { name: "友達になる" })).toBeVisible();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.queryByText(/同意したことになります/)).toBeNull();
  });

  it("設定：「このアプリについて」に2つの行", async () => {
    window.history.replaceState(null, "", "/settings");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/me": json(me),
      "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "このアプリについて", level: 2 })).closest("section");
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByRole("link", { name: /プライバシー ポリシー/ })).toHaveAttribute("href", "/privacy");
    expect(within(section as HTMLElement).getByRole("link", { name: /利用規約/ })).toHaveAttribute("href", "/terms");
  });
});
