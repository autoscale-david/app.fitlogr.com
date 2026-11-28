import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, oauthTokenAad } from "./crypto";

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("token encryption", () => {
  it("round-trips a refresh token with a unique IV", async () => {
    const key = randomKey();
    const aad = oauthTokenAad("user_123");
    const first = await encryptSecret(key, aad, "refresh-token");
    const second = await encryptSecret(key, aad, "refresh-token");
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptSecret(key, aad, first)).toBe("refresh-token");
  });

  it("rejects ciphertext bound to a different user", async () => {
    const key = randomKey();
    const encrypted = await encryptSecret(key, oauthTokenAad("user_a"), "secret");
    await expect(decryptSecret(key, oauthTokenAad("user_b"), encrypted)).rejects.toThrow();
  });
});
