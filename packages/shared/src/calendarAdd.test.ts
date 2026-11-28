import { describe, expect, it } from "vitest";
import { googleCalendarAddUrl } from "./calendarAdd";
import type { Meetup } from "./schemas/invitation";

// Google カレンダーの追加画面の URL（docs/specs/T-59-choose-calendar-add.md「振る舞い 2.」）

const MEETUP_ID = "11111111-2222-4333-8444-555555555555";
const person = (id: string, displayName: string | null, withdrawn = false) => ({ id, displayName, avatarUrl: null, withdrawn });

function meetup(overrides: Partial<Meetup> = {}): Meetup {
  return {
    id: MEETUP_ID,
    startsAt: "2026-11-29T10:00:00.000Z",
    endsAt: "2026-11-29T14:00:00.000Z",
    status: "confirmed",
    participants: [person("aaaaaaaa-0000-4000-8000-000000000001", "あや")],
    area: "渋谷",
    message: "ひみつのひとこと",
    url: null,
    linkPreview: null,
    directInviteId: null,
    broadcastId: null,
    createdAt: "2026-11-28T00:00:00.000Z",
    ...overrides,
  };
}

/** 引数を読む（packages/shared は DOM の型を持たないので URL を使わない） */
const params = (m: Meetup) => {
  const [base, query = ""] = googleCalendarAddUrl(m, "https://app.test").split("?");
  expect(base).toBe("https://calendar.google.com/calendar/render");
  const pairs = query.split("&").map((p) => p.split("=").map(decodeURIComponent) as [string, string]);
  return {
    get: (k: string) => pairs.find(([key]) => key === k)?.[1] ?? null,
    getAll: (k: string) => pairs.filter(([key]) => key === k).map(([, v]) => v),
    has: (k: string) => pairs.some(([key]) => key === k),
    keys: () => pairs.map(([key]) => key),
  };
};

describe("googleCalendarAddUrl", () => {
  it("タイトル・日時（UTC）・場所・説明。ひとことは入れない", () => {
    const p = params(meetup());
    expect(p.get("action")).toBe("TEMPLATE");
    expect(p.get("text")).toBe("ここ暇：あや");
    expect(p.get("dates")).toBe("20261129T100000Z/20261129T140000Z");
    expect(p.get("location")).toBe("渋谷");
    expect(p.get("details")).toBe(`https://app.test/meetups/${MEETUP_ID}`);
    expect(googleCalendarAddUrl(meetup(), "https://app.test")).not.toContain(encodeURIComponent("ひみつ"));
    expect(p.keys().sort()).toEqual(["action", "dates", "details", "location", "text"]);
  });

  it("相手が複数なら「、」でつなぐ。名前がない人・退会した人の名前。相手がいなければ「ここ暇」", () => {
    const many = meetup({
      participants: [
        person("aaaaaaaa-0000-4000-8000-000000000001", "あや"),
        person("aaaaaaaa-0000-4000-8000-000000000002", null),
        person("aaaaaaaa-0000-4000-8000-000000000003", null, true),
      ],
    });
    expect(params(many).get("text")).toBe("ここ暇：あや、名前未設定の友達、退会したユーザー");
    expect(params(meetup({ participants: [] })).get("text")).toBe("ここ暇");
  });

  it("エリアがなければ location を付けない。誘いのリンクがあれば説明の2行め", () => {
    const p = params(meetup({ area: null, url: "https://example.com/shop" }));
    expect(p.has("location")).toBe(false);
    expect(p.get("details")).toBe(`https://app.test/meetups/${MEETUP_ID}\nhttps://example.com/shop`);
  });

  it("入力検証：名前・エリアに & = # 改行を入れても、別の引数ができない", () => {
    const p = params(
      meetup({
        participants: [person("aaaaaaaa-0000-4000-8000-000000000001", "a&dates=1/2#x")],
        area: "渋谷&action=EDIT\nlocation=x",
      }),
    );
    expect(p.get("text")).toBe("ここ暇：a&dates=1/2#x");
    expect(p.get("location")).toBe("渋谷&action=EDIT\nlocation=x");
    expect(p.getAll("dates")).toEqual(["20261129T100000Z/20261129T140000Z"]);
    expect(p.getAll("action")).toEqual(["TEMPLATE"]);
  });
});
