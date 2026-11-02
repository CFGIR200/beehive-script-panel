/**
 * BEE.HIVE BOT — Cloudflare Worker entry point.
 *
 *   fetch      → HTTP surface (webhook, connect page, dashboard)
 *   scheduled  → housekeeping + job executor (cron `* * * * *`)
 */

import type { Env } from "./config/env";
import { readConfig, missingSecrets } from "./config/env";
import { handleRequest } from "./app";
import { drain } from "./provisioning/executor";
import { createLogger } from "./utils/logger";
import * as usersRepo from "./database/repositories/users";
import * as subsRepo from "./database/repositories/subscriptions";
import * as linksRepo from "./database/repositories/links";
import * as settingsRepo from "./database/repositories/settings";
import * as auditRepo from "./database/repositories/audit";
import * as panelsRepo from "./database/repositories/panels";
import * as pendingRepo from "./database/repositories/pending";
import { prune as pruneRateLimits } from "./security/rate-limit";
import { pruneBackups } from "./database/repositories/panels";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const logger = createLogger({ scope: "cron" });
    const missing = missingSecrets(env);
    if (missing.length) {
      logger.error("cron skipped: missing secrets", { missing });
      return;
    }

    let config;
    try {
      config = readConfig(env);
    } catch (error) {
      logger.error("cron skipped: bad configuration", { error });
      return;
    }

    const task = (async () => {
      // 1. Promote the bootstrap admin once, if configured.
      try {
        await usersRepo.ensureBootstrapAdmin(env, config.bootstrapAdminId);
      } catch (error) {
        logger.warn("bootstrap admin failed", { error });
      }

      // 2. Advance provisioning jobs.
      try {
        const results = await drain(env, config, config.jobSliceMs);
        if (results.length) {
          logger.info("jobs advanced", {
            count: results.length,
            outcomes: results.map((result) => result.outcome),
          });
        }
      } catch (error) {
        logger.error("job drain failed", { error });
      }

      // 3. Housekeeping.
      try {
        await subsRepo.expireDue(env);
        await linksRepo.expireStale(env);
        await linksRepo.pruneSessions(env);
        await pendingRepo.prune(env);
        await pruneRateLimits(env);
        await pruneBackups(env);
        await settingsRepo.pruneIdempotency(env);
        await usersRepo.pruneAdminSessions(env);
        const { pruneWebhookEvents } = await import("./auth/telegram");
        await pruneWebhookEvents(env);
        // Audit retention: 90 days (configurable at the database level).
        await auditRepo.prune(env, 90);
      } catch (error) {
        logger.warn("housekeeping failed", { error });
      }

      // 4. Mark stale provisioning panels as failed so they are never orphaned.
      try {
        const stale = await env.DB.prepare(
          `SELECT id FROM panels
            WHERE status = 'provisioning' AND deleted_at IS NULL AND updated_at < ?`,
        )
          .bind(Date.now() - 60 * 60 * 1000)
          .all<{ id: number }>();
        for (const row of stale.results ?? []) {
          await panelsRepo.updateStatus(env, row.id, "failed", "نصب نیمه‌کاره رها شد؛ لطفاً دوباره تلاش کنید.");
        }
      } catch (error) {
        logger.warn("stale panel cleanup failed", { error });
      }
    })();

    ctx.waitUntil(task);
  },
} satisfies ExportedHandler<Env>;
