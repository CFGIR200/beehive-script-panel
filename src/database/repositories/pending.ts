/**
 * Pending connections: the middle step of the connect flow.
 *
 * Step 1 verifies the token with Cloudflare and lists accounts; the token is
 * sealed (AES-256-GCM) and handed to the browser as an opaque handle that
 * expires in 10 minutes. Step 2 uses the handle to pick an account without the
 * token ever being re-submitted or stored in plaintext.
 */

import type { Env } from "../../config/env";
import { all, one, run } from "../db";
import { now } from "../../utils/time";
import { randomToken } from "../../utils/ids";

export interface PendingConnection {
  id: string;
  user_id: number;
  telegram_chat_id: number;
  ciphertext: string;
  iv: string;
  accounts: string;
  attempts: number;
  created_at: number;
  expires_at: number;
}

export interface PendingAccount {
  id: string;
  name: string;
}

export async function create(env: Env, input: {
  userId: number;
  telegramChatId: number;
  ciphertext: string;
  iv: string;
  accounts: PendingAccount[];
  ttlMs: number;
}): Promise<string> {
  const id = randomToken(28);
  const ts = now();
  await run(
    env,
    `INSERT INTO pending_connections (id, user_id, telegram_chat_id, ciphertext, iv, accounts, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.userId,
    input.telegramChatId,
    input.ciphertext,
    input.iv,
    JSON.stringify(input.accounts),
    ts,
    ts + input.ttlMs,
  );
  return id;
}

export async function find(env: Env, id: string): Promise<PendingConnection | null> {
  const row = await one<PendingConnection>(env, "SELECT * FROM pending_connections WHERE id = ?", id);
  if (!row) return null;
  if (row.expires_at < now()) {
    await remove(env, id);
    return null;
  }
  return row;
}

export async function bumpAttempts(env: Env, id: string): Promise<number> {
  await run(env, "UPDATE pending_connections SET attempts = attempts + 1 WHERE id = ?", id);
  const row = await one<{ attempts: number }>(env, "SELECT attempts FROM pending_connections WHERE id = ?", id);
  return Number(row?.attempts ?? 0);
}

export async function remove(env: Env, id: string): Promise<void> {
  await run(env, "DELETE FROM pending_connections WHERE id = ?", id);
}

export async function prune(env: Env): Promise<void> {
  await run(env, "DELETE FROM pending_connections WHERE expires_at < ?", now());
}

export function accountsOf(row: PendingConnection): PendingAccount[] {
  try {
    const parsed = JSON.parse(row.accounts);
    return Array.isArray(parsed) ? (parsed as PendingAccount[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dashboard one-time login codes
// ---------------------------------------------------------------------------

export interface LoginCode {
  handle: string;
  code: string;
  expiresAt: number;
}

export async function createLoginCode(env: Env, userId: number, ttlMs = 5 * 60 * 1000): Promise<LoginCode> {
  const id = randomToken(20);
  // 6 cryptographically random digits
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const code = String(100000 + ((bytes[0] ?? 0) % 900000));
  const { sha256Hex } = await import("../../utils/ids");
  const codeHash = await sha256Hex(`${id}:${code}`);
  const ts = now();
  await run(
    env,
    `INSERT INTO dashboard_login_codes (id, user_id, code_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    userId,
    codeHash,
    ts,
    ts + ttlMs,
  );
  return { handle: id, code, expiresAt: ts + ttlMs };
}

export async function verifyLoginCode(env: Env, handle: string, code: string): Promise<number | null> {
  const id = handle;
  if (!/^[a-z0-9]{16,40}$/.test(id) || !/^[0-9]{6}$/.test(code)) return null;
  const row = await one<{ id: string; user_id: number; code_hash: string; attempts: number; consumed_at: number | null; expires_at: number }>(
    env,
    "SELECT id, user_id, code_hash, attempts, consumed_at, expires_at FROM dashboard_login_codes WHERE id = ?",
    id,
  );
  if (!row || row.consumed_at || row.expires_at < now()) return null;
  if (row.attempts >= 5) return null;
  const { sha256Hex } = await import("../../utils/ids");
  const expected = await sha256Hex(`${row.id}:${code}`);
  if (expected !== row.code_hash) {
    await run(env, "UPDATE dashboard_login_codes SET attempts = attempts + 1 WHERE id = ?", id);
    return null;
  }
  await run(env, "UPDATE dashboard_login_codes SET consumed_at = ? WHERE id = ?", now(), id);
  return row.user_id;
}

export async function listForDebug(env: Env): Promise<unknown[]> {
  return all(env, "SELECT id, user_id, consumed_at FROM dashboard_login_codes ORDER BY created_at DESC LIMIT 10");
}
