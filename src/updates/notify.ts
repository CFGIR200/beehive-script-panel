/**
 * Panel update notifications and auto-apply.
 *
 * The cron trigger compares every active panel's installed version AND build
 * digest with the approved latest artifact (PANEL_ARTIFACT_VERSION +
 * PANEL_ARTIFACT_SHA256, cross-checked against the `panel_versions` registry)
 * and either:
 *   • sends the owner a Telegram notice with a one-tap "update now" button
 *     wired to the existing `panel:update_go` flow (default), or
 *   • with the `update_auto_apply` setting on, queues an update job for every
 *     outdated opened panel directly (UPDALL-1) — no tap needed, progress is
 *     pushed to each owner's chat by the job pipeline itself.
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
import { fa, changelogBlock } from "../bot/messages";
import { cb } from "../bot/keyboards";
import { startUpdateBatch } from "../provisioning/engine";
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
  /** Panels auto-updated this pass (update_auto_apply mode, UPDALL-1). */
  applied: number;
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
    applied: 0,
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

  // The registry digest is what the deploy pipeline verifies against, so the
  // approved PANEL_ARTIFACT_SHA256 var must agree with it. A mismatch means a
  // half-applied release (var bumped, migration not run, or vice versa) —
  // refuse to notify/auto-apply until the operator fixes the deployment.
  const registeredSha = (registered.artifact_sha256 ?? "").toLowerCase();
  const approvedSha = (config.artifactSha256 || "").toLowerCase();
  if (registeredSha && approvedSha && registeredSha !== approvedSha) {
    logger.warn("approved artifact digest does not match registry", {
      version: config.artifactVersion,
      registry: registeredSha.slice(0, 12),
      config: approvedSha.slice(0, 12),
    });
    return result;
  }
  // When the operator did not set PANEL_ARTIFACT_SHA256, trust the registry
  // digest so build-level currency checks still work.
  const expectedSha256 = approvedSha || registeredSha;

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

  // Auto-apply mode (update_auto_apply): the operator has pre-approved the
  // latest artifact for silent rollout. Queue an update job for every outdated
  // opened panel instead of notifying — the job pipeline pushes progress to
  // each owner's chat, so no separate notice is sent. Capacity-limited panels
  // stay outdated and are picked up by the next throttled pass.
  const autoApply = await settingsRepo.getBool(env, "update_auto_apply", false);
  if (autoApply) {
    const applyBatch = Math.max(1, await settingsRepo.getInt(env, "update_apply_batch", 10));
    const rows = await panelsRepo.listOutdatedAll(env, {
      latestVersion: config.artifactVersion,
      expectedSha256,
      limit: applyBatch,
    });
    result.outdated = rows.length;
    if (rows.length > 0) {
      try {
        const batch = await startUpdateBatch(env, config, {
          panelIds: rows.map((row) => row.id),
          actorType: "system",
          actorId: null,
          telegramChatId: null,
        });
        result.applied = batch.queued.length;
        result.failed = batch.skipped.length;
        await auditRepo.record(env, {
          actorType: "system",
          actorId: null,
          action: "updates.autoapply.queued",
          targetType: "panel_versions",
          targetId: config.artifactVersion,
          detail: { applied: result.applied, skipped: batch.skipped.length, capacityReached: batch.capacityReached },
        });
      } catch (error) {
        logger.warn("auto-apply batch failed", { error });
        result.failed = rows.length;
      }
    }
    return result;
  }

  const intervalHours = Math.max(1, await settingsRepo.getInt(env, "update_notify_interval_hours", 24));
  const batch = Math.max(1, await settingsRepo.getInt(env, "update_notify_batch", 10));
  const candidates = await panelsRepo.listOutdatedForNotify(env, {
    latestVersion: config.artifactVersion,
    expectedSha256,
    renotifyBefore: ts - intervalHours * HOUR,
    limit: batch,
  });
  result.outdated = candidates.length;

  for (const candidate of candidates) {
    // UPDRELEASE-1: the notice announces what changed in the target version
    // (changelog_fa of the registry row) relative to the installed version.
    const text = fa.updateNotifyAvailable({
      workerName: candidate.worker_name,
      from: candidate.version,
      to: config.artifactVersion,
      changelog: changelogBlock({
        to: config.artifactVersion,
        from: candidate.version,
        changelogFa: registered.changelog_fa,
      }),
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
