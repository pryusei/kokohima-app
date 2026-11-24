import { PLATFORM_RETENTION, RETENTION } from "@kokohima/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_NOTICE_MARKER, CONTACT_POLICY_MARKER } from "../../../api/scripts/lib/effective-date.mjs";
import { tokenStore } from "../auth/tokenStore";
import { json, mockFetch, renderApp, tokenBody, type Route } from "../test/helpers";
import {
  EFFECTIVE_DATE_LINE,
  PRIVACY_REVISION_CHANGES,
  REVISION_DATE_LINE,
  REVISION_NOTICE_LINE,
  TERMS_REVISION_CHANGES,
} from "./legal";

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

const CHANGES = "この改定で変わるところ";
const PRIVACY_SECTIONS = [
  "1. 運営者と連絡先",
  "2. 預かる情報",
  "3. 使う目的",
  "4. ほかの利用者に見えるもの",
  "5. 外部の事業者に任せること（委託）",
  "6. 第三者への提供",
  "7. 外国の事業者に任せるとき",
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
// 予告の間の形を確かめるための見本（本格稼働までは予告なしで改定するので、legal.ts の値は null。T-19 決めたこと17）
const SAMPLE_NOTICE = "公表日：2026年12月1日（この版は改定日から適用します。それまでは、前の版を適用します）";
const PRIVACY_CHANGES = ["「2.」：見本の変わるところ。"];
const TERMS_CHANGES = ["第6条：見本の変わるところ。"];
const pages = [
  { path: "/privacy", title: "プライバシー ポリシー", section: "1. 運営者と連絡先", sections: PRIVACY_SECTIONS, changes: PRIVACY_CHANGES },
  { path: "/terms", title: "利用規約", section: "第1条（同意）", sections: TERMS_SECTIONS, changes: TERMS_CHANGES },
] as const;

/** 本文の節（h2 の section） */
const clause = (name: string) => screen.getByRole("heading", { name, level: 2 }).closest("section") as HTMLElement;
const DATE_LINE = /^(改定日（効力が生じる日）|公表日)：\d{4}年\d{1,2}月\d{1,2}日/;

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

  it("制定日の下に、改定日の行だけが出る（予告の行と「この改定で変わるところ」はない）", async () => {
    window.history.replaceState(null, "", path);
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: title, level: 1 });
    expect(REVISION_DATE_LINE).toMatch(DATE_LINE);
    expect(REVISION_NOTICE_LINE).toBeNull();
    const dates = screen.getByText(EFFECTIVE_DATE_LINE).parentElement as HTMLElement;
    expect(Array.from(dates.children).map((p) => p.textContent)).toEqual([EFFECTIVE_DATE_LINE, REVISION_DATE_LINE]);
    expect(screen.queryByText(/^公表日：/)).toBeNull();
    expect(screen.queryByRole("heading", { name: CHANGES })).toBeNull();
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

describe("legal.ts の箇条書き", () => {
  it("予告なしで改定しているので、2つの箇条書きも null（T-19 決めたこと17）", () => {
    expect(PRIVACY_REVISION_CHANGES).toBeNull();
    expect(TERMS_REVISION_CHANGES).toBeNull();
  });
});

describe("予告の行があるとき（一般公開のあとの改定）", () => {
  afterEach(() => {
    vi.doUnmock("./legal");
    vi.resetModules();
  });

  it.each(pages)("$path：改定日・予告の行の順に出し、日付の行と本文の間に「この改定で変わるところ」を出す", async ({ path, title, section, sections, changes }) => {
    vi.resetModules();
    vi.doMock("./legal", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./legal")>()),
      REVISION_NOTICE_LINE: SAMPLE_NOTICE,
      PRIVACY_REVISION_CHANGES: PRIVACY_CHANGES,
      TERMS_REVISION_CHANGES: TERMS_CHANGES,
    }));
    const helpers = await import("../test/helpers");
    const legal = await import("./legal");
    window.history.replaceState(null, "", path);
    helpers.mockFetch({ "/api/v1/auth/refresh": helpers.json({}, 401) });
    helpers.renderApp();
    await screen.findByRole("heading", { name: title, level: 1 });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([CHANGES, ...sections]);
    const dates = screen.getByText(EFFECTIVE_DATE_LINE).parentElement as HTMLElement;
    expect(Array.from(dates.children).map((p) => p.textContent)).toEqual([EFFECTIVE_DATE_LINE, legal.REVISION_DATE_LINE, SAMPLE_NOTICE]);
    const notice = clause(CHANGES);
    expect(within(notice).getAllByRole("listitem").map((li) => li.textContent)).toEqual(changes);
    expect(dates.nextElementSibling).toBe(notice);
    expect(notice.compareDocumentPosition(clause(section)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("予告の行がないとき（改定日のあと）", () => {
  afterEach(() => {
    vi.doUnmock("./legal");
    vi.resetModules();
  });

  it.each(pages)("$path：箇条書きがあっても「この改定で変わるところ」を出さず、改定日の行は残す", async ({ path, title }) => {
    vi.resetModules();
    vi.doMock("./legal", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./legal")>()),
      REVISION_NOTICE_LINE: null,
      PRIVACY_REVISION_CHANGES: PRIVACY_CHANGES,
      TERMS_REVISION_CHANGES: TERMS_CHANGES,
    }));
    const helpers = await import("../test/helpers");
    const legal = await import("./legal");
    expect(legal.REVISION_NOTICE_LINE).toBeNull();
    expect(legal.PRIVACY_REVISION_CHANGES).not.toBeNull();
    window.history.replaceState(null, "", path);
    helpers.mockFetch({ "/api/v1/auth/refresh": helpers.json({}, 401) });
    helpers.renderApp();
    await screen.findByRole("heading", { name: title, level: 1 });
    expect(screen.queryByRole("heading", { name: CHANGES })).toBeNull();
    expect(screen.queryByText(/^公表日：/)).toBeNull();
    expect(screen.getByText(legal.REVISION_DATE_LINE as string)).toBeVisible();
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

  // Google の審査のための英語の段落（docs/specs/T-44-landing.md「7.」、T-19 決めたこと18）
  it("「11.」：lang=\"en\" の In English の節に、限定使用の公式の形の英文と User Data Policy へのリンク、日本語と同じ範囲の数行がある", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    const eleven = clause("11. Google から受け取った情報の扱い");
    const en = within(eleven).getByRole("heading", { name: "In English", level: 3 }).closest("section") as HTMLElement;
    expect(en).toHaveAttribute("lang", "en");
    const text = en.textContent ?? "";
    expect(text).toContain(
      "ここ暇 (Kokohima)'s use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    const policy = within(en).getByRole("link", { name: "Google API Services User Data Policy" });
    expect(policy).toHaveAttribute("href", "https://developers.google.com/terms/api-services-user-data-policy");
    expect(policy).toHaveAttribute("rel", "noopener noreferrer");
    expect(text).toContain("The Japanese text above is the authoritative version.");
    // 空き／埋まりだけを読む・書き込みは「ここ暇」カレンダーだけ
    expect(text).toContain("we read only free/busy times");
    expect(text).toContain('We write only to a calendar named "ここ暇"');
    // 使い道と運営が読む場面は、日本語の 11. と同じくカレンダーの情報に絞る。メールアドレスは日本語の 3. と同じ使い道
    expect(text).toContain("Calendar data (free/busy times and the permission to write to the \"ここ暇\" calendar) is used only");
    expect(text).toContain("Our staff read calendar data only");
    expect(text).not.toMatch(/We use this data only/);
    expect(text).toContain("We use your email address only for notification emails");
    // 解除で消えるもの・残るもの（日本語の 8. と同じ）
    expect(text).toContain(`a temporary cache expires within ${RETENTION.freeBusyCacheMinutes} minutes`);
    expect(text).toContain('The "ここ暇" calendar and the plans already written to it stay in your Google Calendar.');
    expect(text).not.toMatch(/delete the stored token and free\/busy data\./);
  });

  it("「5.」「6.」：外国の事業者は「7.」へ送り、監視は Slack の要約と Better Stack の2つの文", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    const five = clause("5. 外部の事業者に任せること（委託）");
    expect(
      within(five).getByText("このサービスは、次の事業者に、必要な範囲で情報の取り扱いを任せています。外国の事業者に任せるときの扱いは「7.」のとおりです。"),
    ).toBeVisible();
    expect(screen.queryByText(/どの事業者も米国の事業者です|「5.」の事業者は米国の事業者です/)).toBeNull();
    const monitoring = within(five).getByRole("heading", { name: "監視のためのサービス", level: 3 }).closest("section") as HTMLElement;
    expect(within(monitoring).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "障害の知らせ（Slack）には、件数と監視の名前と、起きた障害（エラー）の要約を送ります。要約に利用者の情報が入らないことを確かめてから送り、入るおそれがあるときは、要約の知らせは送らず、件数と監視の名前だけにします。",
      "外からの動作の確認（Better Stack）は、このサービスの URL を開くだけです。利用者の情報は渡しません。",
    ]);
    const six = within(clause("6. 第三者への提供")).getAllByRole("listitem").map((li) => li.textContent);
    expect(six).toHaveLength(2);
    expect(six[0]).toContain("次の委託の場合は除きます。");
    expect(six[1]).toContain("外国の事業者に任せるときは、「7.」のとおり、個人情報保護法の基準に適合する体制を整えている事業者にだけ任せます。");
    expect(screen.queryByText(/外国にある第三者への提供として扱い/)).toBeNull();
  });

  it("「7.」：外国の名称・確かめ方・措置・確かめ続けること・外国の制度・連絡先", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    const seven = clause("7. 外国の事業者に任せるとき");
    const sub = (name: string) => within(seven).getByRole("heading", { name, level: 3 }).closest("section") as HTMLElement;
    expect(within(seven).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "外国の名称",
      "体制を整えていることの確かめ方",
      "事業者がとる措置",
      "確かめ続けること",
      "外国の個人情報の保護の制度",
      "もっと詳しく知りたいとき",
    ]);
    const names = within(sub("外国の名称")).getAllByRole("listitem").map((li) => li.textContent);
    expect(names[0]).toBe("米国：Cloudflare・Google・Resend・Slack・Anthropic・ブラウザのプッシュ通知の事業者");
    expect(names.slice(1).map((t) => t?.split("：")[0])).toEqual([
      "Cloudflare での通信の処理",
      "Cloudflare での保管（データベース・ファイル・処理の待ち行列・一時的な記録・ログ）",
    ]);
    const providers = within(sub("体制を整えていることの確かめ方"))
      .getAllByRole("listitem")
      .map((li) => li.textContent?.split("：")[0]);
    expect(providers).toEqual(["Cloudflare", "Google", "Resend", "Slack", "Anthropic", "ブラウザのプッシュ通知の事業者"]);
    const how = sub("体制を整えていることの確かめ方").textContent ?? "";
    expect(how).not.toMatch(/障害の知らせ|Better Stack|Google API の利用規約|ユーザーデータに関するポリシー/);
    expect(sub("事業者がとる措置").textContent).toContain("任された目的の範囲でだけ情報を扱うこと");
    expect(sub("確かめ続けること").textContent).toContain("年に1回と、事業者が契約・条件を変えたと知ったとき");
    expect(sub("外国の個人情報の保護の制度").textContent).toContain("個人情報保護委員会の「外国における個人情報の保護に関する制度等の調査」");
    expect(within(sub("もっと詳しく知りたいとき")).getByRole("link", { name: "ops@kokohima.app" })).toHaveAttribute("href", "mailto:ops@kokohima.app");
    expect(seven.textContent).not.toMatch(/確かめています|支障は見つかっていません/);
    // 仕様書の6節の文案と全文で同じ（箇条書きは、入れ子を除いたその項目の文）
    const own = (li: HTMLElement) => {
      const c = li.cloneNode(true) as HTMLElement;
      c.querySelectorAll("ul,ol").forEach((n) => n.remove());
      return c.textContent?.trim();
    };
    const items = (name: string) => Array.from(sub(name).querySelectorAll("li")).map(own);
    expect(Array.from(seven.querySelectorAll(":scope > p")).map((p) => p.textContent)).toEqual([
      "「5.」の事業者のうち、Cloudflare・Google・Resend・Slack・Anthropic・ブラウザのプッシュ通知の事業者は、外国の事業者です。運営は、個人情報保護法の基準に適合する体制（日本の法律の定めに沿った措置を続けてとるための体制）を整えている事業者にだけ、個人データの取り扱いを任せます。本人の同意によらずに任せるため、外国にある第三者に個人データを渡すときに本人の求めに応じて知らせることになっている事項を、求めを待たずにここに書きます。",
      "監視のための障害の知らせ（Slack）と外からの動作の確認（Better Stack）は、「5.」のとおり、利用者の情報を渡さない使い方にしているので、ここには含めません（問い合わせと通報を届ける Slack は含めます）。",
    ]);
    expect(items("外国の名称")).toEqual([
      "米国：Cloudflare・Google・Resend・Slack・Anthropic・ブラウザのプッシュ通知の事業者",
      "Cloudflare での通信の処理：世界各地の拠点（データセンター）で処理します。どの国の拠点で処理されるかは、アクセスする場所などによって変わるため、前もって特定できません。",
      "Cloudflare での保管（データベース・ファイル・処理の待ち行列・一時的な記録・ログ）：保管する場所の国を指定していないため、Cloudflare が選びます。前もって特定できません。",
    ]);
    expect(sub("体制を整えていることの確かめ方").querySelector("p")?.textContent).toBe(
      "運営は、次の契約・条件に、下の「事業者がとる措置」が定められていることを確かめます。",
    );
    expect(items("体制を整えていることの確かめ方")).toEqual([
      "Cloudflare：Cloudflare のデータ処理に関する契約（DPA）",
      "Google：Google が、ログインとカレンダーの連携で預かるデータの処理について定める条件",
      "Resend：Resend のデータ処理に関する契約（DPA）",
      "Slack：Slack のデータ処理に関する契約（DPA）",
      "Anthropic：Anthropic のデータ処理に関する契約（DPA）",
      "ブラウザのプッシュ通知の事業者：それぞれの事業者が、プッシュ通知の配信について定める条件。渡すのは、その事業者が発行した宛先と、事業者が読めないように暗号化した通知の中身だけです。",
    ]);
    expect(items("事業者がとる措置")).toEqual([
      "確かめるのは、事業者が、任された目的の範囲でだけ情報を扱うこと、安全管理の措置をとること、従業者とほかの委託先を監督すること、漏えいなどがあれば運営に知らせること、ほかの人に渡さないこと、契約が終わったときに情報を消すか返すこと、などです。",
    ]);
    expect(items("確かめ続けること")).toEqual([
      "運営は、年に1回と、事業者が契約・条件を変えたと知ったときに、事業者の措置と、それに影響するおそれのある外国の制度を確かめます。",
      "措置に支障が出たときは、必要な対応をとり、続けるのが難しいときは、その事業者に任せるのをやめます。",
      "措置の実施に支障が見つかったときは、そのことと、とった対応を、ここに書きます。",
    ]);
    expect(items("外国の個人情報の保護の制度")).toEqual([
      "個人情報保護委員会の「外国における個人情報の保護に関する制度等の調査」によると、米国の概要は次のとおりです。",
      "国全体の、個人情報の保護についての包括的な法律はありません。連邦取引委員会（FTC）が、不公正・欺瞞的な行為を禁じる法律（連邦取引委員会法第5条）にもとづいて取り締まるほか、分野ごとの法律（医療・金融・子どもの情報など）と、州の法律があります。",
      "安全保障などのために、政府が事業者に情報の提供を求めることができる制度があります。",
      "詳しくは、個人情報保護委員会の調査をご覧ください。",
    ]);
    expect(items("もっと詳しく知りたいとき")).toEqual([
      "体制の整え方、事業者がとる措置、確かめる頻度と方法、外国の制度、支障の有無とその対応について、もっと詳しく知りたいときは、ops@kokohima.app に求めてください（「12.」）。遅滞なくお知らせします。",
    ]);
  });

  it("行きたいのAI提案（T-29）：「2.」の入力と記録、「3.」の目的、「5.」の Anthropic、「8.」の期間と退会", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    expect(clause("2. 預かる情報").textContent).toContain(
      "行きたいをAIで探すときに入力したエリアと「何をしたい？」の言葉（AIに渡して候補を作るためだけに使い、このサービスには残しません）",
    );
    const purposes = Array.from(clause("3. 使う目的").querySelectorAll("ol > li")).map((li) => li.textContent);
    expect(purposes.at(-1)).toBe("行きたいを置くときに、入力したエリアとしたいことから、AIで店や場所の候補を探すため");
    const anthropic = within(clause("5. 外部の事業者に任せること（委託）"))
      .getByRole("heading", { name: "Anthropic, PBC（米国）", level: 3 })
      .closest("section") as HTMLElement;
    expect(within(anthropic).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "任せること：AI（Claude）で、Web を検索して、店や場所の候補を作ること",
      "渡すもの：「行きたいを探す」に入力したエリアと言葉だけ。利用者を区別する番号・名前・メールアドレス・友達・ここ暇・カレンダーの情報は渡しません。",
    ]);
    const eight = clause("8. 保存する期間").textContent ?? "";
    expect(eight).toContain(
      `行きたいをAIで探した回数の記録（1日に探せる回数を数えるため）：その日から${RETENTION.wishSuggestionAttemptsDaysBefore + 1}日目に消します。`,
    );
    expect(eight).toContain("AIで探した回数の記録は、退会したときにあなたとのつながりを切り、上の期間で消します（サービス全体の1日の回数を数えるため、時刻と結果の種類だけが残ります）。");
  });

  it("問い合わせ（T-24）：「2.」の種類と内容、「3.」の目的とメールアドレス、「5.」の Slack、「8.」の期間と退会、「12.」の求め方", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    expect(clause("2. 預かる情報").textContent).toContain(
      "問い合わせの種類と内容。送るときに、ログインに使っているメールアドレス（LINE でログインした人にはありません）と、利用者を区別する番号を一緒に運営に届けます。",
    );
    const three = clause("3. 使う目的");
    const purposes = Array.from(three.querySelectorAll("ol > li")).map((li) => li.textContent);
    expect(purposes[6]).toBe(
      "不正な利用を防ぎ、障害に気づいて直すため。問い合わせで知らせてもらった不具合を直すため。通報を受けて、危ない使い方や規約に反する使い方に対応するため",
    );
    expect(purposes[8]).toBe("問い合わせでもらったご意見をもとに、このサービスを良くするため");
    expect(three.textContent).toContain("問い合わせのときは、返信先として運営の連絡用の Slack に届けます");
    // 仕様書の6節の文案と同じ並び（Slack は Resend とプッシュ通知の事業者の間）
    expect(within(clause("5. 外部の事業者に任せること（委託）")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Cloudflare, Inc.（米国）",
      "Google LLC（米国）",
      "LINEヤフー株式会社（日本）",
      "Resend（米国の事業者。メールは東京の拠点から送ります）",
      "Slack Technologies, LLC（米国）",
      "Anthropic, PBC（米国）",
      "ブラウザのプッシュ通知の事業者（Google・Apple・Mozilla・Microsoft）",
      "監視のためのサービス",
      "リンクのプレビューを作るとき",
    ]);
    const slack = within(clause("5. 外部の事業者に任せること（委託）"))
      .getByRole("heading", { name: "Slack Technologies, LLC（米国）", level: 3 })
      .closest("section") as HTMLElement;
    expect(within(slack).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "任せること：問い合わせと通報を運営者に届けて、保管すること",
      "渡すもの：問い合わせの種類・内容・受け付けた時刻・利用者を区別する番号・返信先のメールアドレス",
      "通報で渡すもの：理由・くわしく・受け付けた時刻・通報した人と通報された人を区別する番号・ブロックもしたか。誘い・募集から通報したときは、その誘い・募集の日時・エリア・ひとこと・リンク。メールアドレスと名前は渡しません。",
    ]);
    const eight = clause("8. 保存する期間").textContent ?? "";
    expect(eight).toContain(
      `問い合わせ：運営に届けたら、このサービスのデータベースから内容を消します。うまく届かなかったものは、処理の記録として${RETENTION.processedOutboxDays}日で消えます。運営の連絡用の Slack に届いたものは、対応を終えたら消し、遅くとも Slack に届いてから${PLATFORM_RETENTION.contactSlackDays}日で消えます。`,
    );
    expect(eight).toContain("遅くとも Slack に届いてから90日で消えます");
    expect(eight).toContain("まだ運営に届いていない問い合わせと通報は、届けずに消します。");
    expect(clause("12. 開示・訂正・削除などの求め").textContent).toContain(
      "ログインしているなら、アプリの「設定 → 問い合わせ」（種類「個人情報の開示・削除の請求」）からも求められます。",
    );
  });

  // 公開の日と改定日が同じかは、デプロイの検査（apps/api/scripts/lib/effective-date.mjs の contactStartProblems）で確かめる。
  // ここで常に同じことを求めると、次の改定で改定日を変えるたびに問い合わせを閉じることになるため
  // 問い合わせを知らせた改定（2026-11-30）は終わったので、「この改定で変わるところ」の行の目印は、今の箇条書きにはない。
  // デプロイの検査は、本番の本文の目印（CONTACT_POLICY_MARKER）で「前の改定で知らせ済み」と判断する（T-24「11.」）
  it("デプロイの検査が本番の JS で探す問い合わせの目印が本文にある。前の改定の行の目印は、今の箇条書きにない（T-24「11.」）", async () => {
    expect((PRIVACY_REVISION_CHANGES ?? []).some((line) => line.includes(CONTACT_NOTICE_MARKER))).toBe(false);
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    expect(screen.getByRole("heading", { name: CONTACT_POLICY_MARKER, level: 3 })).toBeVisible();
  });

  it("「12.」：「7.」の情報の提供を求められる", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    expect(clause("12. 開示・訂正・削除などの求め").textContent).toContain(
      "第三者への提供の停止、外国の事業者に任せることについての情報（「7.」）の提供を求められます。",
    );
  });

  it("「8.」の保存期間は RETENTION の数をそのまま出す", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    const heading = await screen.findByRole("heading", { name: "8. 保存する期間", level: 2 });
    const text = heading.closest("section")?.textContent ?? "";
    const R = RETENTION;
    const expected = [
      `始まってから${R.availabilityMaxLengthDays + R.availabilityGraceDays}日で消します（枠は最長${R.availabilityMaxLengthDays}日なので、終わってから${R.availabilityGraceDays}〜${R.availabilityMaxLengthDays + R.availabilityGraceDays}日です）`,
      `お知らせの日ごとの数（1日に送る通知の上限を数えるため）：その日から${R.notificationDailyCountsDaysBefore + 1}日目に消します`,
      `使うプレビューがなくなってから${R.linkPreviewImageGraceHours}時間で消します`,
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
    expect(text).toContain("ここ暇の枠：始まってから2日で消します（枠は最長1日なので、終わってから1〜2日です）");
    expect(text).toContain("その日から4日目に消します");
    expect(text).toContain("なくなってから1時間で消します");
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

  it("利用規約：第5条3に、リンクのプレビューの画像の削除の求めと連絡先。第5条4に、アイコンの画像の削除の求め（T-27）", async () => {
    window.history.replaceState(null, "", "/terms");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "利用規約", level: 1 });
    const items = within(clause("第5条（あなたが入力する内容）")).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const third = items[2] as HTMLElement;
    expect(third.textContent).toBe(
      "誘い・募集に付けたリンクのプレビューの画像は、運営がリンク先のページから写して、相手に配ります。写した画像の権利を持つ人などが削除を求めるときは、ops@kokohima.app に知らせてください。内容を確かめ、必要と判断したときは、その画像を配るのをやめて消します。消したあとも、すでに表示した端末には、しばらく残ることがあります。",
    );
    expect(within(third).getByRole("link", { name: "ops@kokohima.app" })).toHaveAttribute("href", "mailto:ops@kokohima.app");
    const fourth = items[3] as HTMLElement;
    expect(fourth.textContent).toContain("アイコンの画像に写っている人や、画像の権利を持つ人などが削除を求めるときは、ops@kokohima.app に知らせてください。");
    expect(within(fourth).getByRole("link", { name: "ops@kokohima.app" })).toHaveAttribute("href", "mailto:ops@kokohima.app");
  });

  it("プライバシー ポリシー：アイコンの画像を預かる情報・見える相手・保存する期間に書く（T-27）", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    expect(clause("2. 預かる情報").textContent).toContain("位置情報などの画像に付いた情報は保存しません");
    expect(clause("2. 預かる情報").textContent).not.toContain("アイコンの画像は持ちません");
    expect(clause("4. ほかの利用者に見えるもの").textContent).toContain("リンクを発行した人の表示名とアイコンの画像が見えます");
    expect(clause("8. 保存する期間").textContent).toContain(`アイコンの画像：変えた・外した・退会したときから${RETENTION.avatarImageGraceHours}時間で消します`);
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
    mockFetch({
      "/api/v1/auth/refresh": json(tokenBody()),
      "/api/v1/invite-links/lookup": lookupOk,
      "/api/v1/me": json({ id: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11", displayName: "ゆう", avatarUrl: null }),
    });
    renderApp();
    expect(await screen.findByRole("button", { name: "友達になる" })).toBeVisible();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.queryByText(/同意したことになります/)).toBeNull();
  });

  it.each([
    ["使えないリンク（404）", json({ type: "about:blank", title: "x", status: 404, code: "not_found", requestId: "r" }, 404), "このリンクは使えません"],
    ["混み合っている（429）", json({ type: "about:blank", title: "x", status: 429, code: "rate_limited", requestId: "r" }, 429), "混み合っています"],
    ["通信できない", (() => Promise.reject(new TypeError("Failed to fetch"))) as Route, "通信できませんでした"],
  ])("招待リンクの受け口：%s のときは、未ログインでも同意の1行でなくリンクだけ", async (_, lookup, text) => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookup });
    renderApp();
    expect(await screen.findByText(new RegExp(text))).toBeVisible();
    expect(screen.getByRole("link", { name: "利用規約" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "プライバシー ポリシー" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByText(/同意したことになります/)).toBeNull();
  });

  it("招待リンクの受け口：使えるリンクで未ログインなら、ログインのボタンと同意の1行", async () => {
    window.history.replaceState(null, "", "/invite#t=secret-invite-token");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401), "/api/v1/invite-links/lookup": lookupOk });
    renderApp();
    expect(await screen.findByRole("link", { name: "Googleでログイン" })).toBeVisible();
    expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === CONSENT)).toBeVisible();
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

// ブロックと通報（docs/specs/T-33-block-report.md「振る舞い 7.」）
describe("ブロックと通報の本文", () => {
  it("プライバシー ポリシー：「2.」の預かる情報、「4.」の見え方、「8.」の期間と退会。日数は retention.ts から", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    const two = clause("2. 預かる情報").textContent ?? "";
    expect(two).toContain("ブロックした相手と、ブロックした時刻");
    expect(two).toContain("通報の理由と、くわしく（書いたときだけ）、通報した相手。");
    expect(clause("4. ほかの利用者に見えるもの").textContent).toContain("ブロックや通報をしたことは、相手に知らせません。");
    const eight = clause("8. 保存する期間").textContent ?? "";
    expect(eight).toContain("ブロック：ブロックをやめたとき、どちらかが退会したときに消します（期限はありません）。");
    expect(eight).toContain(`遅くとも Slack に届いてから${PLATFORM_RETENTION.contactSlackDays}日で消えます。`);
    expect(eight).toContain("あなたについての通報は、通報した人のものなので");
  });

  it("利用規約：第6条に事実でない通報、第7条に通報を受けたときの扱い", async () => {
    window.history.replaceState(null, "", "/terms");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "利用規約", level: 1 });
    expect(clause("第6条（してはいけないこと）").textContent).toContain("事実でない通報をくり返すこと");
    expect(clause("第7条（利用の停止）").textContent).toContain("通報を受けたときは、運営が内容を確かめ");
  });
});

describe("LINE ログインの本文（T-32）", () => {
  it("プライバシー ポリシー：LINE から受け取るのは識別子だけ。LINEヤフーへの委託（日本）と、メールのない人の扱いを書く", async () => {
    window.history.replaceState(null, "", "/privacy");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "プライバシー ポリシー", level: 1 });
    const two = clause("2. 預かる情報").textContent ?? "";
    expect(two).toContain("LINE でログインした人：LINE の識別子（LINE がこのサービスに対して発行する番号）だけ。メールアドレスは受け取りません。");
    expect(two).toContain("LINE の友だちやトークも受け取りません。");
    const five = clause("5. 外部の事業者に任せること（委託）");
    expect(within(five).getByRole("heading", { name: "LINEヤフー株式会社（日本）", level: 3 })).toBeVisible();
    // 日本の事業者なので「7.」の外国の名称には入れない
    expect(clause("7. 外国の事業者に任せるとき").textContent).not.toContain("LINE");
    expect(clause("3. 使う目的").textContent).toContain("メールアドレスがない人には、お知らせ一覧にだけ出します");
    expect(clause("8. 保存する期間").textContent).toContain("Google と LINE の識別子");
    expect(clause("12. 開示・訂正・削除などの求め").textContent).toContain("求めの内容に書いたメールアドレスにお送りします");
  });

  it("利用規約：Google か LINE でログインし、別のアカウントになる", async () => {
    window.history.replaceState(null, "", "/terms");
    mockFetch({ "/api/v1/auth/refresh": json({}, 401) });
    renderApp();
    await screen.findByRole("heading", { name: "利用規約", level: 1 });
    expect(clause("第3条（アカウント）").textContent).toContain("Google と LINE でログインすると別のアカウントになり、あとから1つにまとめられません。");
  });
});
