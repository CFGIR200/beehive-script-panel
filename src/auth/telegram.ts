/**
 * Telegram webhook authentication.
 *
 * Layers, in order:
 *   1. method + content-type + size checks,
 *   2. `X-Telegram-Bot-Api-Secret-Token` compared in constant time (required —
 *      an unauthenticated webhook lets anyone forge updates),
 *   3. `update_id` de-duplication (Telegram retries aggressively on timeouts),
 *   4. per-user rate limiting,
 *   5. user upsert and role resolution.
 */

import type { Env } from "../config/env";
import type { TelegramUpdate, TelegramUser } from "../bot/telegram";
import { RATE_LIMITS, WEBHOOK_DEDUPE_TTL_MS } from "../config/constants";
import { constantTimeEqual, sha256Hex } from "../utils/ids";
import { AppError, messages } from "../utils/errors";
import { consume } from "../security/rate-limit";
import * as usersRepo from "../database/repositories/users";
import * as auditRepo from "../database/repositories/audit";
import { now } from "../utils/time";

export interface WebhookIdentity {
  updateId: number | null;
  user: usersRepo.User;
  roles: usersRepo.Role[];
  isStaff: boolean;
  isAdmin: boolean;
}

export class WebhookAuthError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "WebhookAuthError";
  }
}

export function verifySecret(request: Request, secret: string, updateId: number | null): void {
  if (!secret || secret.length < 16) {
    throw new WebhookAuthError(500, "webhook secret is not configured");
  }
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!provided || !constantTimeEqual(provided, secret)) {
    // Include the update id only to make the log line useful, never the value.
    throw new WebhookAuthError(401, `bad secret token${updateId !== null ? ` (update ${updateId})` : ""}`);
  }
}

/** Records the update; returns false when it was already processed. */
export async function dedupeUpdate(env: Env, update: TelegramUpdate): Promise<boolean> {
  const dedupeKey = `tg:${update.update_id}`;
  try {
    await env.DB.prepare(
      `INSERT INTO webhook_events (source, update_id, dedupe_key, payload_hash, received_at)
       VALUES ('telegram', ?, ?, ?, ?)`,
    )
      .bind(update.update_id, dedupeKey, await sha256Hex(JSON.stringify(update)).then((h) => h.slice(0, 32)), now())
      .run();
    return true;
  } catch {
    // UNIQUE violation → duplicate delivery.
    return false;
  }
}

export async function markUpdateHandled(env: Env, updateId: number, error?: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE webhook_events SET handled = ?, error = ? WHERE dedupe_key = ?")
      .bind(error ? 0 : 1, error ? error.slice(0, 300) : null, `tg:${updateId}`)
      .run();
  } catch {
    /* best effort */
  }
}

export async function pruneWebhookEvents(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM webhook_events WHERE received_at < ?")
    .bind(now() - WEBHOOK_DEDUPE_TTL_MS)
    .run();
}

function extractUser(update: TelegramUpdate): TelegramUser | null {
  return update.message?.from ?? update.callback_query?.from ?? update.edited_message?.from ?? null;
}

export async function authenticate(
  env: Env,
  request: Request,
  update: TelegramUpdate,
): Promise<WebhookIdentity> {
  const telegramUser = extractUser(update);
  if (!telegramUser) throw new WebhookAuthError(200, "update has no user (bot channel post) — ignored");

  const botId = Number(env.TELEGRAM_BOT_TOKEN.split(":")[0]);
  if (Number.isFinite(botId) && telegramUser.id === botId) {
    throw new WebhookAuthError(200, "update from the bot itself — ignored");
  }

  const limit = await consume(env, `tg:u:${telegramUser.id}`, RATE_LIMITS.updatesPerMinute, 60 * 1000);
  if (!limit.allowed) {
    await auditRepo.record(env, {
      actorType: "telegram_user",
      actorId: telegramUser.id,
      action: "webhook.rate_limited",
      severity: "warning",
    });
    throw new AppError("RATE_LIMITED", messages.rateLimited);
  }

  const user = await usersRepo.upsertFromTelegram(env, {
    id: telegramUser.id,
    username: telegramUser.username,
    first_name: telegramUser.first_name,
    last_name: telegramUser.last_name,
    language_code: telegramUser.language_code,
  });

  if (user.is_blocked) {
    throw new AppError("FORBIDDEN", messages.blocked, { detail: "user blocked" });
  }

  const roles = await usersRepo.rolesOf(env, user.id);
  if (roles.length === 0) roles.push("user");

  return {
    updateId: update.update_id ?? null,
    user,
    roles,
    isStaff: usersRepo.isStaff(roles),
    isAdmin: usersRepo.isAdmin(roles),
  };
}
