/**
 * Rollback for failed installs.
 *
 * Only resources that were created *by this job* and recorded in
 * `panel_resources` are removed, and only in reverse creation order. Nothing is
 * guessed and no resource outside the panel's own record is touched.
 */

import type { JobContext } from "./steps";
import * as panelsRepo from "../database/repositories/panels";
import * as jobsRepo from "../database/repositories/jobs";
import * as workersApi from "../cloudflare/workers";
import * as d1Api from "../cloudflare/d1";
import { rollbackPlanFor } from "./planner";

export interface RollbackReport {
  performed: string[];
  failed: Array<{ step: string; error: string }>;
}

export async function rollback(ctx: JobContext, failedStep: string): Promise<RollbackReport> {
  const plan = rollbackPlanFor(ctx.job.kind, failedStep);
  const report: RollbackReport = { performed: [], failed: [] };

  for (const step of plan) {
    try {
      if (step === "delete_worker") {
        const resources = await panelsRepo.liveResourcesOf(ctx.env, ctx.panel.id);
        for (const resource of resources.filter((entry) => entry.kind === "worker_script")) {
          await workersApi.deleteScript(ctx.client, ctx.account.cloudflare_account_id, resource.external_id);
          await panelsRepo.markResourceDeleted(ctx.env, ctx.panel.id, "worker_script", resource.external_id);
          report.performed.push(`worker:${resource.external_id}`);
        }
      } else if (step === "delete_database") {
        const resources = await panelsRepo.liveResourcesOf(ctx.env, ctx.panel.id);
        for (const resource of resources.filter((entry) => entry.kind === "d1_database")) {
          await d1Api.deleteDatabase(ctx.client, ctx.account.cloudflare_account_id, resource.external_id);
          await panelsRepo.markResourceDeleted(ctx.env, ctx.panel.id, "d1_database", resource.external_id);
          report.performed.push(`d1:${resource.external_id}`);
        }
      }
    } catch (error) {
      report.failed.push({ step, error: (error as Error)?.message ?? "unknown" });
      ctx.logger.error("rollback step failed", { step, error });
    }
  }

  await jobsRepo.setStatus(
    ctx.env,
    ctx.job.id,
    report.failed.length ? "rollback_required" : "rolled_back",
  );
  await panelsRepo.updateStatus(
    ctx.env,
    ctx.panel.id,
    report.failed.length ? "failed" : "failed",
    report.failed.length
      ? "بازگردانی کامل نشد؛ منابع باقی‌مانده نیازمند بررسی دستی هستند."
      : "نصب ناموفق بود و منابع ساخته‌شده حذف شدند.",
  );

  return report;
}
