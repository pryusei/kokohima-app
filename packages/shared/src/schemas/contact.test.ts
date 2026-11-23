import { describe, expect, it } from "vitest";
import { contactStartAt, isContactOpen } from "../contactStart";
import contactStart from "../contactStart.json";
import {
  CONTACT_BODY_MAX,
  CONTACT_CATEGORIES,
  CONTACT_CATEGORY_LABELS,
  CONTACT_DAILY_LIMIT,
  CONTACT_LIMIT_WINDOW_HOURS,
  contactBodyLength,
  contactBodySchema,
  contactMessageRequestSchema,
} from "./contact";

// 問い合わせの入力（docs/specs/T-24-contact.md「API」「テスト計画」）

/** 失敗したときの code（refine の message に入れている） */
const issueOf = (body: unknown) => {
  const r = contactBodySchema.safeParse(body);
  return r.success ? null : r.error.issues[0]?.message;
};

describe("contactMessageRequestSchema", () => {
  it("種類と内容だけを受け取る", () => {
    const r = contactMessageRequestSchema.parse({ category: "bug", body: " 動きません " });
    expect(r).toEqual({ category: "bug", body: "動きません" });
  });

  it("知らない項目（userId・email を含む）は400", () => {
    expect(contactMessageRequestSchema.safeParse({ category: "bug", body: "a", userId: "6f1c1f9e-6c2a-4c55-9b7e-2d1f0b0c4a11" }).success).toBe(false);
    expect(contactMessageRequestSchema.safeParse({ category: "bug", body: "a", email: "x@example.com" }).success).toBe(false);
  });

  it("一覧にない種類・内容がない・数値は400", () => {
    expect(contactMessageRequestSchema.safeParse({ category: "spam", body: "a" }).success).toBe(false);
    expect(contactMessageRequestSchema.safeParse({ category: "bug" }).success).toBe(false);
    expect(contactMessageRequestSchema.safeParse({ category: "bug", body: 1 }).success).toBe(false);
  });

  it("種類は4つで、表示の名前と上限は仕様書のとおり", () => {
    expect(CONTACT_CATEGORIES).toEqual(["bug", "feedback", "privacy_request", "other"]);
    expect(CONTACT_CATEGORY_LABELS).toEqual({
      bug: "不具合",
      feedback: "ご意見",
      privacy_request: "個人情報の開示・削除の請求",
      other: "その他",
    });
    expect(CONTACT_BODY_MAX).toBe(1000);
    expect(CONTACT_DAILY_LIMIT).toBe(3);
    expect(CONTACT_LIMIT_WINDOW_HOURS).toBe(24);
  });
});

describe("contactBodySchema", () => {
  it("改行をそろえ、タブを空白に、NFC に、前後の空白を除く", () => {
    expect(contactBodySchema.parse("a\r\nb\rc\td")).toBe("a\nb\nc d");
    expect(contactBodySchema.parse("é")).toBe("é");
    expect(contactBodySchema.parse("  \n x \n  ")).toBe("x");
  });

  it("改行と、絵文字をつなぐ文字（U+200D）は通る", () => {
    expect(contactBodySchema.parse("1行目\n\n\n\n\n\n\n2行目")).toBe("1行目\n\n\n\n\n\n\n2行目");
    expect(contactBodySchema.parse("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("制御文字・孤立サロゲート・書字方向を変える文字は invalid_characters", () => {
    expect(issueOf("a\u0007b")).toBe("invalid_characters");
    expect(issueOf("a\u0085b")).toBe("invalid_characters");
    expect(issueOf("a\ud800b")).toBe("invalid_characters");
    expect(issueOf("a‮b")).toBe("invalid_characters");
    expect(issueOf("a⁦b")).toBe("invalid_characters");
  });

  it("空・空白だけは too_short", () => {
    expect(issueOf("")).toBe("too_short");
    expect(issueOf(" \n\t ")).toBe("too_short");
  });

  it("1000文字（4バイトの文字・サロゲートペア）は通り、1001文字は too_long", () => {
    const max = "𠮷".repeat(CONTACT_BODY_MAX);
    expect(max.length).toBe(2000);
    expect(contactBodySchema.parse(max)).toBe(max);
    expect(issueOf(`${max}a`)).toBe("too_long");
  });

  it("生の文字列は8000文字（UTF-16）までは正規化に進み、8001文字は too_long", () => {
    // 前後の空白を除くと1文字になる
    expect(contactBodySchema.parse(`${" ".repeat(7999)}a`)).toBe("a");
    expect(issueOf(`${" ".repeat(8000)}a`)).toBe("too_long");
  });

  it("画面の文字数は、正規化して前後の空白を除いたコードポイントで数える", () => {
    expect(contactBodyLength("  𠮷a\r\n ")).toBe(2);
    expect(contactBodyLength("é")).toBe(1);
  });
});

describe("公開の日（docs/specs/T-24-contact.md「振る舞い 11.」）", () => {
  it("startDate の日本時間の0時", () => {
    expect(contactStartAt("2026-12-02")).toBe(Date.parse("2026-12-01T15:00:00Z"));
    expect(contactStartAt(null)).toBeNull();
  });

  it("JSON の値は、未定（null）か暦にある日付", () => {
    const { startDate } = contactStart as { startDate: string | null };
    if (startDate !== null) {
      expect(startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${startDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(startDate);
    }
    expect(contactStartAt()).toBe(contactStartAt(startDate));
  });

  it("1ミリ秒前は閉じ、ちょうどから開く。null ならいつも閉じる", () => {
    const at = contactStartAt("2026-12-02") ?? 0;
    expect(isContactOpen(at - 1, at)).toBe(false);
    expect(isContactOpen(at, at)).toBe(true);
    expect(isContactOpen(Number.MAX_SAFE_INTEGER, null)).toBe(false);
  });
});
