import { describe, expect, it } from "vitest";
import { DAY_MS } from "../domain/directInvite";
import { attemptSend } from "./directInvites";

// 送信の読み直しとやり直し（docs/specs/T-04-direct-invite.md「送信」）。DB を使わずに組み合わせを確かめる

const now = Date.parse("2026-10-10T00:00:00Z");
const clear = { friends: true, duplicate: false, sent: 0, oldest: null };

function script(inserts: boolean[]) {
  let calls = 0;
  return {
    insert: async () => inserts[calls++] ?? false,
    get calls() {
      return calls;
    },
  };
}

describe("attemptSend", () => {
  it("書ければそのまま", async () => {
    const s = script([true]);
    expect(await attemptSend(s.insert, async () => clear, now)).toEqual({ kind: "inserted" });
    expect(s.calls).toBe(1);
  });

  it("判定の順番：友達でなければ、同じ誘い・上限より先に404", async () => {
    const why = { friends: false, duplicate: true, sent: 20, oldest: now - 1000 };
    expect(await attemptSend(script([false]).insert, async () => why, now)).toEqual({ kind: "not_found" });
    expect(await attemptSend(script([false]).insert, async () => ({ ...why, friends: true }), now)).toEqual({
      kind: "duplicate",
    });
    expect(
      await attemptSend(script([false]).insert, async () => ({ ...why, friends: true, duplicate: false }), now),
    ).toEqual({ kind: "rate_limited", retryAfterSeconds: Math.ceil((DAY_MS - 1000) / 1000) });
  });

  it("どの条件にも当てはまらなければ1回だけやり直す。やり直しで書ければ成功、だめなら409", async () => {
    const ok = script([false, true]);
    expect(await attemptSend(ok.insert, async () => clear, now)).toEqual({ kind: "inserted" });
    expect(ok.calls).toBe(2);
    const ng = script([false, false, true]);
    expect(await attemptSend(ng.insert, async () => clear, now)).toEqual({ kind: "duplicate" });
    expect(ng.calls).toBe(2);
  });
});
