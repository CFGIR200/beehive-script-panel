/** Runtime system settings and idempotency keys. */

import type { Env } from "../../config/env";
import { all, one, run } from "../db";
import { now } from "../../utils/time";

export async function get(env: Env, key: string, fallback: string | null = null): Promise<string | null> {
  const row = await one<{ value: string | null }>(env, "SELECT value FROM system_settings WHERE key = ?", key);
  return row?.value ?? fallback;
}

export async function getBool(env: Env, key: string, fallback = false): Promise<boolean> {
  const value = await get(env, key, null);
  if (value === null) return fallback;
  return value === "1" || value === "true";
}

export async function getInt(env: Env, key: string, fallback: number): Promise<number> {
  const value = await get(env, key, null);
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function set(env: Env, key: string, value: string | null, updatedBy: number | null = null): Promise<void> {
  await run(
    env,
    `INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
    key,
    value,
    updatedBy,
    now(),
  );
}

export async function all_(env: Env): Promise<Record<string, string | null>> {
  const rows = await all<{ key: string; value: string | null }>(env, "SELECT key, value FROM system_settings");
  const out: Record<string, string | null> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** Returns the cached response for a key, or null when this is the first call. */
export async function lookupIdempotency(env: Env, key: string): Promise<string | null> {
  const row = await one<{ response: string | null; expires_at: number }>(
    env,
    "SELECT response, expires_at FROM idempotency_keys WHERE key = ?",
    key,
  );
  if (!row) return null;
  if (row.expires_at < now()) {
    await run(env, "DELETE FROM idempotency_keys WHERE key = ?", key);
    return null;
  }
  return row.response;
}

export async function rememberIdempotency(
  env: Env,
  key: string,
  scope: string,
  response: unknown,
  ttlMs: number,
): Promise<void> {
  const ts = now();
  await run(
    env,
    `INSERT INTO idempotency_keys (key, scope, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET response = excluded.response, expires_at = excluded.expires_at`,
    key,
    scope,
    JSON.stringify(response ?? null),
    ts,
    ts + ttlMs,
  );
}

export async function pruneIdempotency(env: Env): Promise<void> {
  await run(env, "DELETE FROM idempotency_keys WHERE expires_at < ?", now());
}
