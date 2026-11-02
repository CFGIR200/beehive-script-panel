/**
 * Input validation. Every value that reaches the database or the Cloudflare API
 * passes through one of these guards. Throws AppError("VALIDATION_FAILED").
 */

import { AppError, messages } from "../utils/errors";
import { HARD_LIMITS } from "../config/constants";

function fail(field: string, reason: string): never {
  throw new AppError("VALIDATION_FAILED", `${messages.validation} (${field})`, { detail: `${field}: ${reason}` });
}

export function requireString(value: unknown, field: string, opts: { min?: number; max?: number; trim?: boolean } = {}): string {
  if (typeof value !== "string") fail(field, "expected string");
  const out = opts.trim === false ? value : value.trim();
  const min = opts.min ?? 1;
  const max = opts.max ?? HARD_LIMITS.maxBodyBytes;
  if (out.length < min) fail(field, `shorter than ${min}`);
  if (out.length > max) fail(field, `longer than ${max}`);
  return out;
}

export function optionalString(value: unknown, field: string, opts: { max?: number } = {}): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, { min: 1, max: opts.max ?? 1000 });
}

export function requireInteger(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) fail(field, "expected integer");
  const min = opts.min ?? Number.MIN_SAFE_INTEGER;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (n < min || n > max) fail(field, `out of range [${min}, ${max}]`);
  return n;
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  fail(field, "expected boolean");
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const candidate = String(value ?? "").trim();
  if (!(allowed as readonly string[]).includes(candidate)) fail(field, `expected one of ${allowed.join("|")}`);
  return candidate as T;
}

/**
 * Cloudflare API token shape check only — the real authority is
 * /user/tokens/verify. Rejecting obvious junk early keeps useless requests off
 * the Cloudflare API and stops anyone pasting a *bot* token into the form.
 */
export function requireCloudflareToken(value: unknown): string {
  const token = requireString(value, "cloudflare_token", { min: 40, max: 64 });
  if (!/^[A-Za-z0-9_-]+$/.test(token)) fail("cloudflare_token", "unexpected characters");
  if (token.includes(":")) fail("cloudflare_token", "looks like a bot token");
  if (/\s/.test(value as string)) fail("cloudflare_token", "whitespace inside the token");
  return token;
}

/** Telegram chat ids are integers; accept negative (groups) though we only serve private chats. */
export function requireTelegramId(value: unknown, field = "telegram_id"): number {
  return requireInteger(value, field, { min: -1e15, max: 1e15 });
}

/** Cloudflare account ids are 32 hex characters. */
export function requireCloudflareAccountId(value: unknown): string {
  const id = requireString(value, "cloudflare_account_id", { min: 32, max: 32 });
  if (!/^[0-9a-f]{32}$/i.test(id)) fail("cloudflare_account_id", "expected 32 hex characters");
  return id.toLowerCase();
}

/**
 * Worker script names: lowercase alphanumerics and dashes only, no leading or
 * trailing dash, ≤ 63 chars (64 with the ".workers.dev" label rules in mind).
 */
export function requireWorkerName(value: unknown): string {
  const name = requireString(value, "worker_name", { min: 3, max: HARD_LIMITS.maxWorkerNameLength });
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) fail("worker_name", "must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$");
  if (name.includes("--")) fail("worker_name", "consecutive dashes are not allowed");
  return name;
}

/** Free-text search box: strip control characters, cap the length. */
export function sanitizeSearchTerm(value: unknown, max = 64): string {
  const raw = String(value ?? "").trim();
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
  return cleaned;
}

/**
 * Numbers typed by a Persian-speaking operator (۱۴۸ char digits) are accepted
 * and normalised. Used by the admin panels for limits and prices.
 */
export function toEnglishDigits(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function requirePositiveIntFa(value: unknown, field: string, opts: { min?: number; max?: number; allowZero?: boolean } = {}): number {
  const text = toEnglishDigits(String(value ?? "").trim()).replace(/,/g, "");
  if (!/^-?\d+$/.test(text)) fail(field, "expected number");
  return requireInteger(Number(text), field, {
    min: opts.min ?? (opts.allowZero ? 0 : 1),
    max: opts.max ?? 1_000_000_000,
  });
}

/** Guard for values interpolated into URLs (prevents SSRF-ish path games). */
export function requireUuid(value: unknown, field = "id"): string {
  const text = requireString(value, field, { min: 36, max: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    fail(field, "expected uuid");
  }
  return text.toLowerCase();
}
