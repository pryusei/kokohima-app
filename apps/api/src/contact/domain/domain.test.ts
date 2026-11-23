import { CONTACT_BODY_MAX } from "@kokohima/shared";
import { describe, expect, it } from "vitest";
import { buildSlackMessage, escapeSlack, formatJst, SECTION_TEXT_MAX, splitEscaped } from "./slackMessage";
import { checkWebhookUrl, CONTACT_WEBHOOK_TARGET } from "./webhook";

// 問い合わせの domain（docs/specs/T-24-contact.md「振る舞い 4.」「テスト計画」）

const ENTITY = /&(?:amp|lt|gt);/g;
/** 塊の終わりが、エンティティの途中・サロゲートペアの間でない */
function endsCleanly(chunk: string) {
  const last = chunk.charCodeAt(chunk.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return false;
  const amp = chunk.lastIndexOf("&");
  return amp === -1 || /^&(?:amp|lt|gt);/.test(chunk.slice(amp));
}
const startsCleanly = (chunk: string) => {
  const first = chunk.charCodeAt(0);
  return !(first >= 0xdc00 && first <= 0xdfff) && !/^(?:amp|lt|gt);/.test(chunk);
};

describe("splitEscaped", () => {
  it("ふつうの内容は1つ", () => {
    expect(splitEscaped("こんにちは")).toEqual(["こんにちは"]);
    expect(splitEscaped("")).toEqual([""]);
  });

  it("& を1000個：2つに分かれ、どれも3000文字以下で、つなぐと元の内容のエスケープと同じ", () => {
    const body = "&".repeat(CONTACT_BODY_MAX);
    const chunks = splitEscaped(body);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length <= SECTION_TEXT_MAX)).toBe(true);
    expect(chunks.join("")).toBe(escapeSlack(body));
    expect(chunks.every((c) => (c.match(ENTITY)?.join("") ?? "") === c)).toBe(true);
  });

  it("& と絵文字（サロゲートペア）を混ぜる：エンティティの途中とペアの間で切れない", () => {
    // 1文字目の絵文字で境目をずらし、& と 😀 が交互に続く（エスケープのあとの長さは 5 と 2）
    const body = Array.from({ length: CONTACT_BODY_MAX }, (_, i) => (i % 2 === 0 ? "😀" : "&")).join("");
    expect(Array.from(body)).toHaveLength(CONTACT_BODY_MAX);
    const chunks = splitEscaped(body);
    // 500 × 2（😀）＋ 500 × 5（&amp;）＝ 3500 文字
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.length <= SECTION_TEXT_MAX)).toBe(true);
    for (const c of chunks) {
      expect(endsCleanly(c)).toBe(true);
      expect(startsCleanly(c)).toBe(true);
    }
    expect(chunks.join("")).toBe(escapeSlack(body));
  });

  it("小さい上限でも、エンティティとペアの境目だけで切る", () => {
    for (const max of [5, 6, 7, 9, 11]) {
      const body = "a&😀<b>&&😀😀>";
      const chunks = splitEscaped(body, max);
      expect(chunks.join(""), String(max)).toBe(escapeSlack(body));
      for (const c of chunks) {
        expect(c.length, `${max} ${c}`).toBeLessThanOrEqual(max);
        expect(endsCleanly(c), `${max} ${c}`).toBe(true);
        expect(startsCleanly(c), `${max} ${c}`).toBe(true);
      }
    }
  });
});

describe("Slack の文", () => {
  it("エスケープは & < > の3つだけ", () => {
    expect(escapeSlack("<!channel> & @here *b* :smile:")).toBe("&lt;!channel&gt; &amp; @here *b* :smile:");
  });

  it("日本時間の受付の時刻", () => {
    expect(formatJst("2026-11-23T05:05:00.000Z")).toBe("2026-11-23 14:05（日本時間）");
    expect(formatJst("2026-12-31T15:00:00.000Z")).toBe("2027-01-01 00:00（日本時間）");
  });

  it("text は種類だけで、すべて plain_text・emoji: false", () => {
    const m = buildSlackMessage({
      category: "privacy_request",
      email: null,
      occurredAt: "2026-11-23T05:05:00.000Z",
      userId: "u",
      receiptId: "r",
      body: "内容",
    });
    expect(m.text).toBe("問い合わせ：個人情報の開示・削除の請求");
    const texts = m.blocks.flatMap((b) => ("fields" in b ? b.fields : [b.text]));
    expect(texts.every((t) => t.type === "plain_text" && t.emoji === false)).toBe(true);
    expect(texts.map((t) => t.text)).toContain("返信先：登録なし");
  });
});

describe("checkWebhookUrl", () => {
  it("https・同じホスト・ポートなし・接頭辞で始まるものだけ", () => {
    expect(checkWebhookUrl("https://hooks.slack.com/services/T/B/x", CONTACT_WEBHOOK_TARGET)?.toString()).toBe(
      "https://hooks.slack.com/services/T/B/x",
    );
    for (const raw of [
      undefined,
      "",
      "::",
      "http://hooks.slack.com/services/T/B/x",
      "https://hooks.slack.com.example.com/services/T/B/x",
      "https://hooks.slack.com:8443/services/T/B/x",
      "https://hooks.slack.com/servicesX/T",
      "https://u:p@hooks.slack.com/services/T/B/x",
    ]) {
      expect(checkWebhookUrl(raw, CONTACT_WEBHOOK_TARGET), String(raw)).toBeNull();
    }
  });
});
