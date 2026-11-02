/**
 * Broadcast delivery.
 *
 * Telegram allows roughly 30 messages/second per bot; we send in chunks with a
 * delay and count per-recipient failures (blocked bots are normal). The run is
 * recorded in the audit log and can be paused with the `broadcast_paused`
 * setting.
 */

import type { Env } from "../config/env";
import type { TelegramClient } from "../bot/telegram";
import * as usersRepo from "../database/repositories/users";
import * as auditRepo from "../database/repositories/audit";
import * as settingsRepo from "../database/repositories/settings";
import { all } from "../database/db";
import { createLogger } from "../utils/logger";

export interface BroadcastResult {
  sent: number;
  failed: number;
  skipped: number;
}

export async function recipients(env: Env, limit = 5000): Promise<number[]> {
  const rows = await all<{ telegram_id: number }>(
    env,
    "SELECT telegram_id FROM users WHERE is_blocked = 0 ORDER BY id ASC LIMIT ?",
    limit,
  );
  return rows.map((row) => Number(row.telegram_id));
}

export async function countRecipients(env: Env): Promise<number> {
  return usersRepo.count(env, { blocked: false });
}

export async function broadcast(
  env: Env,
  input: { text: string; adminUserId: number; telegram: TelegramClient; chunkSize?: number },
): Promise<BroadcastResult> {
  const logger = createLogger({ scope: "broadcast" });
  const paused = await settingsRepo.getBool(env, "broadcast_paused", false);
  if (paused) return { sent: 0, failed: 0, skipped: 0 };

  const list = await recipients(env);
  const chunkSize = input.chunkSize ?? 25;
  let sent = 0;
  let failed = 0;

  for (let index = 0; index < list.length; index += chunkSize) {
    const chunk = list.slice(index, index + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((chatId) => input.telegram.sendMessage(chatId, input.text)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") sent += 1;
      else failed += 1;
    }
    // Respect the ~30 msg/s ceiling between chunks.
    if (index + chunkSize < list.length) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(chunkSize / 30) * 1000));
    }
  }

  await auditRepo.record(env, {
    actorType: "admin",
    actorId: input.adminUserId,
    action: "broadcast.sent",
    severity: "warning",
    detail: { sent, failed, total: list.length },
  });
  logger.info("broadcast finished", { sent, failed, total: list.length });
  return { sent, failed, skipped: list.length - sent - failed };
}
