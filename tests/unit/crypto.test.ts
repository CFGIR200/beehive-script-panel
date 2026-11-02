import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { credentialContext, CryptoError, hmacSha256Hex, randomHex, seal, unseal } from "../../src/security/crypto";
import { toBase64 } from "../../src/utils/ids";

const KEY = env.CREDENTIAL_ENCRYPTION_KEY;
const CTX = credentialContext(7, 11, "cloudflare_api_token");

describe("AES-256-GCM credential sealing", () => {
  it("round-trips a token", async () => {
    const sealed = await seal("super-secret-token-value", CTX, KEY);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain("super-secret");
    const opened = await unseal(sealed, CTX, KEY);
    expect(opened).toBe("super-secret-token-value");
  });

  it("uses a fresh IV per record (no deterministic ciphertext)", async () => {
    const first = await seal("same-value", CTX, KEY);
    const second = await seal("same-value", CTX, KEY);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects a ciphertext replayed under another tenant context", async () => {
    const sealed = await seal("tenant-a-token", CTX, KEY);
    const otherTenant = credentialContext(8, 11, "cloudflare_api_token");
    await expect(unseal(sealed, otherTenant, KEY)).rejects.toBeInstanceOf(CryptoError);
  });

  it("rejects tampered ciphertext", async () => {
    const sealed = await seal("value", CTX, KEY);
    const bytes = atob(sealed.ciphertext).split("");
    bytes[0] = String.fromCharCode(bytes[0]!.charCodeAt(0) ^ 0xff);
    const tampered = { ...sealed, ciphertext: btoa(bytes.join("")) };
    await expect(unseal(tampered, CTX, KEY)).rejects.toBeInstanceOf(CryptoError);
  });

  it("supports key rotation through the previous key", async () => {
    const oldKey = toBase64(new Uint8Array(32).fill(7));
    const newKey = toBase64(new Uint8Array(32).fill(9));
    const sealed = await seal("rotating-value", CTX, oldKey);
    await expect(unseal(sealed, CTX, newKey)).rejects.toBeInstanceOf(CryptoError);
    await expect(unseal(sealed, CTX, newKey, oldKey)).resolves.toBe("rotating-value");
  });

  it("rejects keys that are not 32 bytes", async () => {
    await expect(seal("x", CTX, toBase64(new Uint8Array(16)))).rejects.toBeInstanceOf(CryptoError);
  });

  it("produces unique HMAC signatures", async () => {
    const a = await hmacSha256Hex("k", "message");
    const b = await hmacSha256Hex("k", "message ");
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it("generates 32-char random hex", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});
