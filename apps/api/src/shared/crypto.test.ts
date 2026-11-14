import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, SecretDecryptError, secretKid } from "./crypto";

// 更新用トークンの暗号化（docs/specs/T-06-calendar.md「トークンの暗号化」）

const KEYS = env.CALENDAR_TOKEN_KEYS;
const AAD = "calendar:google:user-a";

describe("encryptSecret / decryptSecret", () => {
  it("往復でき、平文は保存の形に入らない", async () => {
    const stored = await encryptSecret("refresh-secret", KEYS, "cal-1", AAD);
    expect(stored).toMatch(/^v1\.cal-1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain("refresh-secret");
    expect(await decryptSecret(stored, KEYS, AAD)).toBe("refresh-secret");
    expect(secretKid(stored)).toBe("cal-1");
  });

  it("毎回 IV が違う", async () => {
    const a = await encryptSecret("same", KEYS, "cal-1", AAD);
    const b = await encryptSecret("same", KEYS, "cal-1", AAD);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
    expect(a).not.toBe(b);
  });

  it("古い鍵の行を、鍵IDで復号できる", async () => {
    const stored = await encryptSecret("old", KEYS, "cal-old", AAD);
    expect(await decryptSecret(stored, KEYS, AAD)).toBe("old");
  });

  it("知らない鍵ID・AAD の違い（別の人の行に写した）・改ざん・壊れた形は失敗する", async () => {
    const stored = await encryptSecret("x", KEYS, "cal-1", AAD);
    const fail = async (p: Promise<unknown>, reason: string) => {
      const error = await p.then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(SecretDecryptError);
      expect((error as SecretDecryptError).reason).toBe(reason);
    };
    await fail(decryptSecret(stored.replace("cal-1", "cal-9"), KEYS, AAD), "unknown_kid");
    await fail(decryptSecret(stored, KEYS, "calendar:google:user-b"), "invalid");
    const parts = stored.split(".");
    const tampered = [...parts.slice(0, 3), `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1)}`].join(".");
    await fail(decryptSecret(tampered, KEYS, AAD), "invalid");
    await fail(decryptSecret("v2.cal-1.a.b", KEYS, AAD), "malformed");
    await fail(encryptSecret("x", KEYS, "cal-9", AAD), "unknown_kid");
  });
});
