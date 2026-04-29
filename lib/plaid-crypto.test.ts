import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken } from "./plaid-crypto";

beforeAll(() => {
  // Use a deterministic test key (64 hex chars = 32 bytes)
  process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
});

describe("plaid-crypto", () => {
  it("round-trips a Plaid access token", () => {
    const original = "access-sandbox-abc123-def456-ghi789";
    const { enc, iv, tag } = encryptToken(original);
    expect(decryptToken(enc, iv, tag)).toBe(original);
  });

  it("produces different ciphertext each call (unique IV)", () => {
    const token = "access-sandbox-same-token";
    const first = encryptToken(token);
    const second = encryptToken(token);
    expect(first.iv).not.toBe(second.iv);
    expect(first.enc).not.toBe(second.enc);
  });

  it("throws when the GCM auth tag is tampered", () => {
    const { enc, iv } = encryptToken("my-secret-token");
    const badTag = "00".repeat(16); // wrong tag
    expect(() => decryptToken(enc, iv, badTag)).toThrow();
  });

  it("throws when the ciphertext is tampered", () => {
    const { enc, iv, tag } = encryptToken("my-secret-token");
    const badEnc = enc.slice(0, -2) + (enc.slice(-2) === "ff" ? "00" : "ff");
    expect(() => decryptToken(badEnc, iv, tag)).toThrow();
  });

  it("throws when PLAID_ENCRYPTION_KEY is missing", () => {
    const saved = process.env.PLAID_ENCRYPTION_KEY;
    delete process.env.PLAID_ENCRYPTION_KEY;
    expect(() => encryptToken("token")).toThrow(/PLAID_ENCRYPTION_KEY/);
    process.env.PLAID_ENCRYPTION_KEY = saved;
  });

  it("throws when PLAID_ENCRYPTION_KEY is wrong length", () => {
    process.env.PLAID_ENCRYPTION_KEY = "tooshort";
    expect(() => encryptToken("token")).toThrow(/PLAID_ENCRYPTION_KEY/);
    process.env.PLAID_ENCRYPTION_KEY = "a".repeat(64);
  });
});
