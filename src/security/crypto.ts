/**
 * Cryptography primitives.
 *
 * Design notes
 * ------------
 * • Cloudflare API tokens are sealed with AES-256-GCM using a key held in a
 *   Worker secret (never in D1). Each record gets a fresh 12-byte IV and an
 *   AAD that binds the ciphertext to `userId:accountRef:purpose`, so a row
 *   copied to another tenant cannot be decrypted successfully.
 * • Key rotation: `keyVersion` is stored with the ciphertext; sealing always
 *   uses the current key, unsealing accepts the current key and the optional
 *   previous key (CREDENTIAL_ENCRYPTION_KEY_PREVIOUS) for one migration window.
 * • Web Crypto only — no Node crypto, no third-party crypto dependency.
 */

import { fromBase64, toBase64 } from "../utils/ids";

const IV_BYTES = 12;
const KEY_BYTES = 32;
export const CURRENT_KEY_VERSION = 1;

export interface SealedValue {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

const keyCache = new Map<string, CryptoKey>();

function parseKey(material: string, label: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(material.trim());
  } catch {
    throw new CryptoError(`${label} is not valid base64`);
  }
  if (bytes.length !== KEY_BYTES) {
    throw new CryptoError(`${label} must decode to exactly ${KEY_BYTES} bytes (got ${bytes.length})`);
  }
  return bytes;
}

type KeyUsageFlag = "encrypt" | "decrypt" | "sign" | "verify";

async function importKey(material: string, label: string, usage: KeyUsageFlag[]): Promise<CryptoKey> {
  const cacheKey = `${label}:${usage.join(",")}:${material.length}:${material.slice(-6)}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const bytes = parseKey(material, label);
  const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM", length: 256 }, false, usage);
  keyCache.set(cacheKey, key);
  return key;
}

function aadFor(context: string): Uint8Array {
  return new TextEncoder().encode(context);
}

/** Seals a UTF-8 string. `context` must be stable for the lifetime of the record. */
export async function seal(plaintext: string, context: string, rawKey: string): Promise<SealedValue> {
  if (!plaintext) throw new CryptoError("nothing to seal");
  if (!context) throw new CryptoError("context is required");
  const key = await importKey(rawKey, "CREDENTIAL_ENCRYPTION_KEY", ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aadFor(context), tagLength: 128 },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv), keyVersion: CURRENT_KEY_VERSION };
}

/** Opens a sealed value. Throws CryptoError when the context or key is wrong. */
export async function unseal(
  sealed: SealedValue,
  context: string,
  rawKey: string,
  previousKey?: string,
): Promise<string> {
  const candidates: Array<{ material: string; label: string }> = [{ material: rawKey, label: "CREDENTIAL_ENCRYPTION_KEY" }];
  if (previousKey) candidates.push({ material: previousKey, label: "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS" });

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const key = await importKey(candidate.material, candidate.label, ["encrypt", "decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(sealed.iv),
          additionalData: aadFor(context),
          tagLength: 128,
        },
        key,
        fromBase64(sealed.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch (error) {
      lastError = error;
    }
  }
  throw new CryptoError(`unable to open sealed value: ${(lastError as Error)?.message ?? "unknown"}`);
}

/** Stable AAD for stored Cloudflare credentials. */
export function credentialContext(userId: number, accountRef: number, purpose: string): string {
  return `beehive:v1:${purpose}:${userId}:${accountRef}`;
}

/** HMAC-SHA256 hex — used for session signatures and connect-link hashes. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Cryptographically strong random hex string. */
export function randomHex(bytes = 16): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
