import { contactStartAt } from "@kokohima/shared";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";
import { DESKTOP_QUERY } from "../ui/useDesktop";

// 問い合わせ（docs/specs/T-24-contact.md「9.」「11.」「テスト計画」）

const START = contactStartAt() ?? 0;
const PATH = "/api/v1/contact-messages";

const problem = (status: number, code: string) => () =>
  new Response(JSON.stringify({ type: "about:blank", title: "x", status, code, requestId: "r" }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
const noContent = () => new Response(null, { status: 204 });
const offline: Route = () => {
  throw new TypeError("Failed to fetch");
};

/** 端末の時刻（公開の日の前後）。描画のたびに読む Date.now を差し替える */
const at = (now: number) => vi.spyOn(Date, "now").mockReturnValue(now);

beforeEach(() => {
  tokenStore.clear();
  at(START);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(contact: Route | Route[] = noContent) {
  window.history.replaceState(null, "", "/settings/contact");
  const mocked = mockFetch({
    "/api/v1/auth/refresh": json(tokenBody()),
    "/api/v1/notifications/unread-count": json({ count: 0 }),
    [PATH]: contact,
  });
  renderApp();
  return mocked;
}

const sendButton = () => screen.getByRole("button", { name: "送る" });
const textarea = () => screen.getByLabelText("内容");

async function fill(category: string, body: string) {
  await userEvent.click(await screen.findByRole("button", { name: category }));
  fireEvent.change(textarea(), { target: { value: body } });
}

const posts = (calls: { url: string; init: RequestInit }[]) => calls.filter((c) => c.url === PATH);
const keyOf = (call: { init: RequestInit } | undefined) => new Headers(call?.init.headers).get("Idempotency-Key");

describe("入口と画面の枠", () => {
  it("設定のトップの「このアプリについて」の最初の行に「問い合わせ」があり、/settings/contact に移る", async () => {
    window.history.replaceState(null, "", "/settings");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me": json({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null }),
      "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    });
    renderApp();
    const section = (await screen.findByRole("heading", { name: "このアプリについて" })).closest("section") as HTMLElement;
    const links = Array.from(section.querySelectorAll("a")).map((a) => a.textContent?.replace("›", "").trim());
    expect(links[0]).toBe("問い合わせ");
    expect(links).toEqual(expect.arrayContaining(["プライバシー ポリシー", "利用規約"]));
    await userEvent.click(screen.getByRole("link", { name: /問い合わせ/ }));
    expect(await screen.findByRole("heading", { name: "問い合わせ", level: 1 })).toBeVisible();
    expect(window.location.pathname).toBe("/settings/contact");
  });

  it("SubScreen（題「問い合わせ」、戻るで /settings）", async () => {
    open();
    expect(await screen.findByRole("heading", { name: "問い合わせ", level: 1 })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "戻る" }));
    await waitFor(() => expect(window.location.pathname).toBe("/settings"));
  });

  it("PC の配置では、左のナビの「設定」に aria-current=\"page\" が付く", async () => {
    vi.stubGlobal(
      "matchMedia",
      // 動きを止める設定の問い合わせにも true（docs/specs/T-56-motion.md「0-3.」）
      vi.fn((q: string) => ({ matches: q === DESKTOP_QUERY || q === "(prefers-reduced-motion: reduce)", media: q, addEventListener: () => {}, removeEventListener: () => {} })),
    );
    open();
    expect(await screen.findByRole("link", { name: "設定" })).toHaveAttribute("aria-current", "page");
  });

  it("ログインしていなければログインへ移り、戻り先は /settings/contact", async () => {
    window.history.replaceState(null, "", "/settings/contact");
    mockFetch({ "/api/v1/auth/refresh": problem(401, "unauthenticated") });
    renderApp();
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(new URLSearchParams(window.location.search).get("returnTo")).toBe("/settings/contact");
  });
});

describe("公開の日（「11.」）", () => {
  it("前は、設定のトップに「問い合わせ」の行がなく、/settings/contact はみんなのタブになる", async () => {
    at(START - 1);
    window.history.replaceState(null, "", "/settings");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/me": json({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null }),
      "/api/v1/calendar/connections": json({ google: { status: "none", connectedAt: null } }),
    });
    const view = renderApp();
    expect(await screen.findByRole("link", { name: /プライバシー ポリシー/ })).toBeVisible();
    expect(screen.queryByRole("link", { name: /問い合わせ/ })).toBeNull();
    view.unmount();

    window.history.replaceState(null, "", "/settings/contact");
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      "/api/v1/friend-availabilities": json({ items: [], nextCursor: null }),
      "/api/v1/friends": json({ items: [], nextCursor: null }),
    });
    renderApp();
    // 知らない経路と同じく、みんなのタブを出す
    expect(await screen.findByRole("heading", { name: "みんな", level: 1 })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "問い合わせ" })).toBeNull();
  });

  it("E2E の画面だけは開く（vite の define。本番のビルドと Vitest では false）", () => {
    const config = readFileSync(join(import.meta.dirname, "../../vite.config.ts"), "utf8");
    expect(config).toContain('__CONTACT_FORCE_OPEN__: JSON.stringify(process.env.E2E === "1")');
    expect(__CONTACT_FORCE_OPEN__).toBe(false);
  });
});

describe("入力", () => {
  it("種類を選ばない・内容が空・1000文字を超えるときは押せない。選べるのは1つだけ", async () => {
    open();
    await screen.findByRole("heading", { name: "問い合わせ", level: 1 });
    expect(sendButton()).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: "内容" } });
    expect(sendButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "不具合" }));
    await userEvent.click(screen.getByRole("button", { name: "ご意見" }));
    expect(screen.getByRole("button", { name: "ご意見" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "不具合" })).toHaveAttribute("aria-pressed", "false");
    expect(sendButton()).toBeEnabled();
    fireEvent.change(textarea(), { target: { value: "  \n " } });
    expect(sendButton()).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: "𠮷".repeat(1001) } });
    expect(sendButton()).toBeDisabled();
  });

  it("文字数は正規化のあとのコードポイントで数え、超えたら超えた数の文になる", async () => {
    open();
    await screen.findByRole("heading", { name: "問い合わせ", level: 1 });
    expect(screen.getByText("0 / 1000")).toBeVisible();
    fireEvent.change(textarea(), { target: { value: "  𠮷a\r\n " } });
    expect(screen.getByText("2 / 1000")).toBeVisible();
    fireEvent.change(textarea(), { target: { value: "a".repeat(1123) } });
    expect(screen.getAllByText("1000文字までです（123文字多い）")[0]).toBeVisible();
    expect(textarea()).not.toHaveAttribute("maxLength");
  });

  it("「個人情報の開示・削除の請求」を選んだときだけ、本人の確認・退会の説明が出る", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "不具合" }));
    expect(screen.queryByText(/本人の確認のため/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "個人情報の開示・削除の請求" }));
    expect(screen.getByText(/本人の確認のため/)).toHaveTextContent(/運営に届く前に退会すると、この求めは届きません/);
    expect(screen.getByText(/本人の確認のため/)).toHaveTextContent(/退会もできます/);
  });

  it("Slack に届くことと、プライバシー ポリシーへのリンク", async () => {
    open();
    expect(await screen.findByText(/米国の Slack 社のサービス/)).toBeVisible();
    expect(screen.getByRole("link", { name: "プライバシー ポリシー" })).toHaveAttribute("href", "/privacy");
  });

  it("オフラインでは押せず、「オフラインの間は送れません」が出る", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    open();
    await fill("不具合", "内容");
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText("オフラインの間は送れません")).toBeVisible();
  });
});

describe("送る", () => {
  it("POST に category・body と Idempotency-Key が付き、204で「送りました」の確認に置き換わる", async () => {
    const { calls } = open();
    await fill("不具合", "動きません");
    await userEvent.click(sendButton());
    expect(await screen.findByRole("heading", { name: "送りました" })).toBeVisible();
    expect(screen.getByText("受け付けました。返事が要るものは、メールでお返しします。").closest("[role=status]")).not.toBeNull();
    expect(screen.queryByLabelText("内容")).toBeNull();
    expect(screen.getByRole("link", { name: "設定に戻る" })).toHaveAttribute("href", "/settings");
    const [post] = posts(calls);
    expect(post?.init.method).toBe("POST");
    expect(JSON.parse(String(post?.init.body))).toEqual({ category: "bug", body: "動きません" });
    expect(keyOf(post)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [problem(429, "rate_limited"), "今日はこれ以上送れません。時間をおいて、もう一度お試しください。"],
    [problem(500, "internal_error"), "送れませんでした。もう一度お試しください。"],
    [offline, "送れませんでした。もう一度お試しください。"],
    [problem(400, "validation_failed"), "送れませんでした。内容を確かめてください。"],
    [problem(409, "request_in_progress"), "送れませんでした。もう一度お試しください。"],
    [problem(422, "idempotency_key_mismatch"), "送れませんでした。もう一度お試しください。"],
    [problem(404, "not_found"), "送れませんでした。もう一度お試しください。"],
  ])("送れなかったとき（%#）は静かな文言が出て、入力が残る", async (route, text) => {
    open(route);
    await fill("ご意見", "残る内容");
    await userEvent.click(sendButton());
    const message = await screen.findByText(text);
    expect(message).toHaveAttribute("role", "status");
    expect(message.className).toContain("text-ink-muted");
    expect(textarea()).toHaveValue("残る内容");
    expect(screen.getByRole("button", { name: "ご意見" })).toHaveAttribute("aria-pressed", "true");
  });

  it("通信できない・5xx のあとに同じ内容で押すと同じキー。409・422 のあと・内容を変えたあとは新しいキー", async () => {
    const { calls } = open([offline, problem(500, "internal_error"), problem(409, "request_in_progress"), problem(422, "idempotency_key_mismatch"), noContent]);
    await fill("不具合", "同じ内容");
    const click = async (n: number) => {
      await userEvent.click(sendButton());
      await waitFor(() => expect(posts(calls)).toHaveLength(n));
      await waitFor(() => expect(sendButton()).toBeEnabled());
    };
    await click(1);
    await click(2);
    await click(3);
    const sent = posts(calls);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
    expect(keyOf(sent[2])).toBe(keyOf(sent[1]));
    await click(4);
    expect(keyOf(posts(calls)[3])).not.toBe(keyOf(sent[2]));
    fireEvent.change(textarea(), { target: { value: "変えた内容" } });
    await userEvent.click(sendButton());
    await waitFor(() => expect(posts(calls)).toHaveLength(5));
    expect(keyOf(posts(calls)[4])).not.toBe(keyOf(posts(calls)[3]));
  });

  it("401 は1回だけ取り直して同じキーで送り直す", async () => {
    const { calls } = open([problem(401, "unauthenticated"), noContent]);
    await fill("その他", "内容");
    await userEvent.click(sendButton());
    expect(await screen.findByRole("heading", { name: "送りました" })).toBeVisible();
    const sent = posts(calls);
    expect(sent).toHaveLength(2);
    expect(keyOf(sent[1])).toBe(keyOf(sent[0]));
  });

  it("401 の取り直しにも失敗したら、送り直さずにログアウトの状態になり、文言は足さない", async () => {
    window.history.replaceState(null, "", "/settings/contact");
    const { calls } = mockFetch({
      "/api/v1/auth/refresh": [json(tokenBody()), problem(401, "unauthenticated")],
      "/api/v1/notifications/unread-count": json({ count: 0 }),
      [PATH]: problem(401, "unauthenticated"),
    });
    renderApp();
    await fill("その他", "内容");
    await userEvent.click(sendButton());
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(posts(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.url === "/api/v1/auth/refresh")).toHaveLength(2);
    expect(screen.queryByText(/送れませんでした|今日はこれ以上送れません/)).toBeNull();
  });

  it("書きかけの内容を localStorage・sessionStorage に書かない", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    open();
    await fill("不具合", "書きかけの内容");
    await userEvent.click(sendButton());
    await screen.findByRole("heading", { name: "送りました" });
    expect(local.mock.calls.flat().join("")).not.toContain("書きかけの内容");
  });
});

describe("色", () => {
  it("問い合わせの画面と部品に、赤・エラー色（Tailwind の既定の色）がない", () => {
    for (const file of ["ContactPage.tsx", "../ui/form.tsx"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(source, file).not.toMatch(/\b(?:text|bg|border)-(?:red|rose|pink|orange|amber|slate|gray|zinc|neutral|stone)-\d/);
      expect(source, file).not.toMatch(/danger|error-|text-error|bg-error/);
    }
  });
});
