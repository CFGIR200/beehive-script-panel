/** Identifier and random-value helpers. */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAME_ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const NAME_WORDS = ["honey", "nectar", "comb", "pollen", "swarm", "drone", "wax", "bloom", "buzz", "hive"];

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** URL-safe random token (default 32 chars ≈ 165 bits). */
export function randomToken(length = 32, alphabet: string = ALPHABET): string {
  if (length <= 0) throw new Error("length must be positive");
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function traceId(): string {
  return `tr_${randomToken(16)}`;
}

/**
 * Worker name generator: `<word>-<4 alnum>` e.g. `honey-8f3k`.
 * Matches Cloudflare rules: lowercase alphanumeric and dashes, must not start
 * or end with a dash, ≤ 63 chars. Deterministic alphabet keeps names readable.
 */
export function workerName(existing: Set<string> = new Set()): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const word = NAME_WORDS[Math.floor(Math.random() * NAME_WORDS.length)]!;
    const suffix = randomToken(4);
    const candidate = `${word}-${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `hive-${randomToken(8)}`;
}

/** D1 database name: `<word>-db-<6 alnum>` — D1 names allow dashes and letters. */
export function databaseName(worker: string): string {
  const base = worker.replace(/[^a-z0-9-]/g, "").slice(0, 40);
  return `${base}-db`.slice(0, 60);
}

/** Recovery key: 32 chars of high-entropy base32-ish text, shown once to the owner. */
export function recoveryKey(): string {
  return randomToken(12) + "-" + randomToken(12);
}

/** Panel public uid — short, non-guessable, never derived from internal ids. */
export function panelUid(): string {
  return `pn_${randomToken(12)}`;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    binary += String.fromCharCode(...view.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
