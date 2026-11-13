/**
 * Panel update notifications.
 *
 * The cron trigger compares every active panel's installed version with the
 * approved latest version (PANEL_ARTIFACT_VERSION, cross-checked against the
 * `panel_versions` registry) and sends the owner a Telegram notice with a
 * one-tap "update now" button wired to the existing `panel:update_go` flow.
 *
 * Notices are remembered per panel (`update_notified_version` +
 * `update_notice_at`): a customer is pinged exactly once per new version, then
 * reminded at most every `update_notify_interval_hours` until the panel is
 * actually updated. Data safety is part of the message contract: an update
 * job re-uploads only the Worker script, so the customer D1 (users, settings,
 * external-config library) and the BEEHIVE patches baked into the approved
 * artifact always survive the update — see docs/UPDATES.md.
 */

import type { Env, PublicConfig } from "../config/env";
import type { TelegramClient } from "../bot/telegram";
import { fa } from "../bot/messages";
import { cb } from "../bot/keyboards";
import * as panelsRepo from "../database/repositories/panels";
import * as settingsRepo from "../database/repositories/settings";
import * as auditRepo from "../database/repositories/audit";
import { now } from "../utils/time";
import { createLogger } from "../utils/logger";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface UpdateCheckResult {
  /** false when the update_notify_enabled setting is off. */
  enabled: boolean;
  /** true when this pass was skipped by the update_check_min_minutes throttle. */
  throttled: boolean;
  latestVersion: string;
  /** Panels that were due a notice when the check ran. */
  outdated: number;
  notified: number;
  failed: number;
}

/** Runs one update-notification pass. Never throws — callers log the result. */
export async function runUpdateCheck(
  env: Env,
  config: PublicConfig,
  telegram: TelegramClient,
): Promise<UpdateCheckResult> {
  const logger = createLogger({ scope: "updates.notify" });
  const result: UpdateCheckResult = {
    enabled: true,
    throttled: false,
    latestVersion: config.artifactVersion,
    outdated: 0,
    notified: 0,
    failed: 0,
  };

  const enabled = await settingsRepo.getBool(env, "update_notify_enabled", true);
  if (!enabled) {
    result.enabled = false;
    return result;
  }

  // The target version must exist in the registry and be active. A stale
  // PANEL_ARTIFACT_VERSION var (or an artifact that failed verification) must
  // never notify customers that they can update to it.
  const registered = await panelsRepo.findVersion(env, config.artifactVersion);
  if (!registered || !registered.is_active) {
    logger.warn("latest panel version missing or inactive in registry", {
      version: config.artifactVersion,
    });
    return result;
  }

  // Throttle whole passes; the cron fires every minute and one indexed query
  // per pass is still wasteful when nothing changed.
  const minMinutes = await settingsRepo.getInt(env, "update_check_min_minutes", 30);
  const lastCheck = await settingsRepo.getInt(env, "update_check_last_at", 0);
  const ts = now();
  if (minMinutes > 0 && lastCheck > 0 && ts - lastCheck < minMinutes * MINUTE) {
    result.throttled = true;
    return result;
  }
  await settingsRepo.set(env, "update_check_last_at", String(ts));

  const intervalHours = Math.max(1, await settingsRepo.getInt(env, "update_notify_interval_hours", 24));
  const batch = Math.max(1, await settingsRepo.getInt(env, "update_notify_batch", 10));
  const candidates = await panelsRepo.listOutdatedForNotify(env, {
    latestVersion: config.artifactVersion,
    renotifyBefore: ts - intervalHours * HOUR,
    limit: batch,
  });
  result.outdated = candidates.length;

  for (const candidate of candidates) {
    const text = fa.updateNotifyAvailable({
      workerName: candidate.worker_name,
      from: candidate.version,
      to: config.artifactVersion,
    });
    try {
      await telegram.sendMessage(candidate.user_telegram_id, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ به‌روزرسانی به ${config.artifactVersion}`, callback_data: cb("panel", "update_go", candidate.id) }],
            [{ text: "👁 مشاهده پنل", callback_data: cb("panel", "view", candidate.id) }],
          ],
        },
      });
      await panelsRepo.markUpdateNotified(env, candidate.id, config.artifactVersion);
      result.notified += 1;
    } catch (error) {
      // Blocked bot / network hiccup: counted and retried on a later pass.
      logger.warn("update notice failed", { panelId: candidate.id, error });
      result.failed += 1;
    }
  }

  if (result.notified > 0 || result.failed > 0) {
    await auditRepo.record(env, {
      actorType: "system",
      actorId: null,
      action: "updates.notify.sent",
      targetType: "panel_versions",
      targetId: config.artifactVersion,
      detail: { notified: result.notified, failed: result.failed, outdated: result.outdated },
    });
  }
  return result;
}
