import { describe, expect, it } from "vitest";
import { broadcastStatusTone, statusTone } from "../invitations/format";

// 状態のバッジの色（docs/specs/T-11-design.md「共通の部品」）

describe("statusTone", () => {
  it("成立は meet、返事待ちは pending、この時間なら は lamp", () => {
    expect(statusTone("confirmed")).toBe("meet");
    expect(statusTone("pending")).toBe("pending");
    expect(statusTone("counter_proposed")).toBe("lamp");
  });

  it("断り・期限切れ・見送り・やっぱり難しいは、すべて同じ quiet（互いに区別しない）", () => {
    const tones = (["declined", "expired", "skipped", "cancelled"] as const).map(statusTone);
    expect(new Set(tones)).toEqual(new Set(["quiet"]));
  });
});

describe("broadcastStatusTone", () => {
  it("決まった募集は meet、募集中は pending、宛先の人が応じたあとは lamp", () => {
    expect(broadcastStatusTone({ status: "decided", direction: "received", respondedByMe: true })).toBe("meet");
    expect(broadcastStatusTone({ status: "open", direction: "sent", respondedByMe: null })).toBe("pending");
    expect(broadcastStatusTone({ status: "open", direction: "received", respondedByMe: false })).toBe("pending");
    expect(broadcastStatusTone({ status: "open", direction: "received", respondedByMe: true })).toBe("lamp");
  });

  it("期限切れと締め切りは同じ quiet（宛先の人に、決まったか期限切れかを区別させない）", () => {
    expect(broadcastStatusTone({ status: "expired", direction: "sent", respondedByMe: null })).toBe("quiet");
    expect(broadcastStatusTone({ status: "closed", direction: "received", respondedByMe: true })).toBe("quiet");
    expect(broadcastStatusTone({ status: "closed", direction: "received", respondedByMe: false })).toBe("quiet");
  });
});
