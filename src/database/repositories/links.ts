/**
 * One-time Cloudflare connect links and the bot conversation sessions.
 *
 * The token itself is never stored: only `sha256(token)` goes to D1, so a
 * database leak cannot be replayed against the connect endpoint.
 */

import type { Env } from "../../config/env";
import { all, one, run } from "../db";
import { now } from "../../utils/time";

export interface ConnectLink {
  token_hash: string;
  user_id: number;
  telegram_chat_id: number;
  status: "pending" | "used" | "expired" | "revoked";
  attempts: number;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  ip: string | null;
}

export async function createLink(env: Env, input: {
  tokenHash: string;
  userId: number;
  telegramChatId: number;
  expiresAt: number;
}): Promise<void> {
  // Only one live link per user: creating a new one invalidates the old ones.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE connect_links SET status = 'revoked' WHERE user_id = ? AND status = 'pending'",
    ).bind(input.userId),
    env.DB.prepare(
      `INSERT INTO connect_links (token_hash, user_id, telegram_chat_id, status, created_at, expires_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).bind(input.tokenHash, input.userId, input.telegramChatId, now(), input.expiresAt),
  ]);
}

export async function findLink(env: Env, tokenHash: string): Promise<ConnectLink | null> {
  return one<ConnectLink>(env, "SELECT * FROM connect_links WHERE token_hash = ?", tokenHash);
}

/** Atomically consumes a link. Returns false when it was already used/expired. */
export async function consumeLink(env: Env, tokenHash: string, ip: string): Promise<boolean> {
  const ts = now();
  const result = await run(
    env,
    `UPDATE connect_links SET status = 'used', used_at = ?, ip = ?
      WHERE token_hash = ? AND status = 'pending' AND expires_at > ?`,
    ts,
    ip,
    tokenHash,
    ts,
  );
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function registerAttempt(env: Env, tokenHash: string): Promise<number> {
  await run(env, "UPDATE connect_links SET attempts = attempts + 1 WHERE token_hash = ?", tokenHash);
  const row = await one<{ attempts: number }>(env, "SELECT attempts FROM connect_links WHERE token_hash = ?", tokenHash);
  return Number(row?.attempts ?? 0);
}

export async function expireStale(env: Env): Promise<void> {
  await run(env, "UPDATE connect_links SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", now());
}

// ---------------------------------------------------------------------------
// Bot conversation sessions
// ---------------------------------------------------------------------------

export interface BotSession {
  chat_id: number;
  user_id: number;
  state: string;
  payload: string;
  message_id: number | null;
  updated_at: number;
  expires_at: number;
}

export async function getSession(env: Env, chatId: number): Promise<BotSession | null> {
  const session = await one<BotSession>(env, "SELECT * FROM bot_sessions WHERE chat_id = ?", chatId);
  if (!session) return null;
  if (session.expires_at < now()) {
    await clearSession(env, chatId);
    return null;
  }
  return session;
}

export async function setSession(env: Env, input: {
  chatId: number;
  userId: number;
  state: string;
  payload: Record<string, unknown>;
  messageId: number | null;
  ttlMs: number;
}): Promise<void> {
  const ts = now();
  await run(
    env,
    `INSERT INTO bot_sessions (chat_id, user_id, state, payload, message_id, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chat_id) DO UPDATE SET
       user_id = excluded.user_id, state = excluded.state, payload = excluded.payload,
       message_id = excluded.message_id, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
    input.chatId,
    input.userId,
    input.state,
    JSON.stringify(input.payload ?? {}),
    input.messageId,
    ts,
    ts + input.ttlMs,
  );
}

export async function clearSession(env: Env, chatId: number): Promise<void> {
  await run(env, "DELETE FROM bot_sessions WHERE chat_id = ?", chatId);
}

export async function allSessions(env: Env, state: string): Promise<BotSession[]> {
  return all<BotSession>(env, "SELECT * FROM bot_sessions WHERE state = ? AND expires_at > ?", state, now());
}

export async function pruneSessions(env: Env): Promise<void> {
  await run(env, "DELETE FROM bot_sessions WHERE expires_at < ?", now());
}
