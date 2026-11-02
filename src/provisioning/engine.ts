/**
 * Provisioning engine — public entry points.
 *
 * Every operation:
 *   1. checks plan limits and global concurrency,
 *   2. refuses to start while another job for the same panel is active,
 *   3. records a job with an immutable step plan,
 *   4. kicks the executor via `waitUntil` (bounded) — the cron trigger finishes
 *      whatever does not fit in one request.
 */

import type { Env, PublicConfig } from "../config/env";
import * as jobsRepo from "../database/repositories/jobs";
import type { Job, JobKind } from "../database/repositories/jobs";
import * as panelsRepo from "../database/repositories/panels";
import type { Panel } from "../database/repositories/panels";
import * as accountsRepo from "../database/repositories/accounts";
import * as auditRepo from "../database/repositories/audit";
import * as settingsRepo from "../database/repositories/settings";
import { stepNames } from "./planner";
import type { InstallPayload } from "./steps";
import { drain } from "./executor";
import { assertCanBackup, assertCanInstall, assertCanUpdate } from "../subscriptions/limits";
import { AppError, toAppError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { databaseName as makeDatabaseName, panelUid, traceId, uuid, workerName as makeWorkerName, recoveryKey } from "../utils/ids";
import { humanBytes } from "../panels/artifact";

export interface StartContext {
  userId: number;
  telegramChatId: number | null;
  traceId?: string;
}

export interface StartedJob {
  job: Job;
  panel: Panel | null;
  workerName?: string;
}

function trace(ctx: StartContext): string {
  return ctx.traceId ?? traceId();
}

/** Global cap on simultaneous jobs so one customer cannot starve Cloudflare's API rate limits. */
async function assertGlobalCapacity(env: Env): Promise<void> {
  const [active, limit] = await Promise.all([
    jobsRepo.activeJobCount(env),
    settingsRepo.getInt(env, "max_global_concurrency", 6),
  ]);
  if (active >= limit) {
    throw new AppError("RATE_LIMITED", "سرور در حال پردازش درخواست‌های دیگر است؛ لطفاً چند لحظه بعد تلاش کنید.", {
      detail: `global concurrency ${active}/${limit}`,
    });
  }
}

async function assertPanelIdle(env: Env, panelId: number): Promise<void> {
  const active = await jobsRepo.activeJobForPanel(env, panelId);
  if (active) {
    throw new AppError("CONFLICT", "برای این پنل یک عملیات در حال اجراست.", { detail: `job ${active.id} active` });
  }
}

/** Kicks the executor in the background without blocking the webhook response. */
export function kickExecutor(env: Env, config: PublicConfig, ctx?: ExecutionContext): void {
  const task = drain(env, config, Math.min(config.jobSliceMs, 20000)).catch(() => {
    /* cron will pick the job up */
  });
  if (ctx?.waitUntil) ctx.waitUntil(task);
}

export async function startInstall(
  env: Env,
  config: PublicConfig,
  ctx: StartContext & { accountRef: number; requestedWorkerName?: string | null; version?: string },
): Promise<StartedJob> {
  const logger = createLogger({ traceId: trace(ctx), scope: "engine.install" });
  await assertCanInstall(env, ctx.userId);
  await assertGlobalCapacity(env);

  const account = await accountsRepo.findForUser(env, ctx.userId, ctx.accountRef);
  if (!account) throw new AppError("NOT_FOUND", "حساب Cloudflare موردنظر پیدا نشد.");
  if (account.token_status !== "active") {
    throw new AppError("UNAUTHORIZED", "اتصال این حساب Cloudflare فعال نیست؛ لطفاً دوباره متصل کنید.");
  }

  const version = ctx.version ?? config.artifactVersion;
  const registered = await panelsRepo.findVersion(env, version);
  if (!registered || !registered.is_active) {
    throw new AppError("ARTIFACT_MISSING", `نسخهٔ ${version} پنل در دسترس نیست.`);
  }

  // Worker names must be unique inside the account and stable once chosen.
  const used = new Set(await panelsRepo.workerNamesForAccount(env, account.id));
  let workerName = (ctx.requestedWorkerName || "").trim().toLowerCase();
  if (workerName) {
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(workerName.replace(/-+/g, "-"))) {
      throw new AppError("VALIDATION_FAILED", "نام Worker فقط می‌تواند شامل حروف کوچک انگلیسی، رقم و خط تیره باشد.");
    }
    if (used.has(workerName)) {
      throw new AppError("CONFLICT", "این نام Worker قبلاً استفاده شده است.");
    }
  } else {
    workerName = makeWorkerName(used);
  }

  const databaseName = makeDatabaseName(workerName);
  const jobId = uuid();
  const tid = trace(ctx);

  const panel = await panelsRepo.reserve(env, {
    uid: panelUid(),
    userId: ctx.userId,
    accountRef: account.id,
    cloudflareAccountId: account.cloudflare_account_id,
    workerName,
    d1DatabaseName: databaseName,
    status: "provisioning",
    version,
  });

  const job = await jobsRepo.create(env, {
    id: jobId,
    userId: ctx.userId,
    panelId: panel.id,
    accountRef: account.id,
    kind: "install",
    payload: { workerName, databaseName, version, accountRef: account.id, cloudflareAccountId: account.cloudflare_account_id } satisfies InstallPayload,
    traceId: tid,
    telegramChatId: ctx.telegramChatId,
    steps: stepNames("install"),
  });

  await auditRepo.record(env, {
    actorType: "telegram_user",
    actorId: ctx.userId,
    action: "panel.install.started",
    targetType: "panel",
    targetId: panel.uid,
    traceId: tid,
    detail: { workerName, version, accountRef: account.id },
  });

  logger.info("install job created", { jobId, workerName, panelUid: panel.uid });
  return { job, panel, workerName };
}

export async function startUpdate(
  env: Env,
  config: PublicConfig,
  ctx: StartContext & { panelId: number; redeploy?: boolean },
): Promise<StartedJob> {
  const panel = await panelsRepo.findForUser(env, ctx.userId, ctx.panelId);
  if (!panel) throw new AppError("NOT_FOUND", "پنل موردنظر پیدا نشد.");
  if (panel.status === "deleted") throw new AppError("CONFLICT", "این پنل حذف شده است.");
  await assertCanUpdate(env, ctx.userId);
  await assertPanelIdle(env, panel.id);
  await assertGlobalCapacity(env);

  const version = config.artifactVersion;
  const registered = await panelsRepo.findVersion(env, version);
  if (!registered || !registered.is_active) {
    throw new AppError("ARTIFACT_MISSING", `نسخهٔ ${version} پنل در دسترس نیست.`);
  }
  if (!ctx.redeploy && panel.version === version) {
    throw new AppError("CONFLICT", `پنل از قبل روی نسخهٔ ${version} است.`);
  }

  const kind: JobKind = ctx.redeploy ? "redeploy" : "update";
  const job = await jobsRepo.create(env, {
    id: uuid(),
    userId: ctx.userId,
    panelId: panel.id,
    accountRef: panel.account_ref,
    kind,
    payload: {
      workerName: panel.worker_name,
      databaseName: panel.d1_database_name,
      version,
      accountRef: panel.account_ref,
      cloudflareAccountId: panel.cloudflare_account_id,
      d1DatabaseId: panel.d1_database_id ?? undefined,
      subdomain: undefined,
      previousVersion: panel.version ?? undefined,
      previousSha: panel.artifact_sha256 ?? undefined,
    } satisfies InstallPayload,
    traceId: trace(ctx),
    telegramChatId: ctx.telegramChatId,
    steps: stepNames(kind),
  });

  await panelsRepo.updateStatus(env, panel.id, "updating");
  await auditRepo.record(env, {
    actorType: "telegram_user",
    actorId: ctx.userId,
    action: ctx.redeploy ? "panel.redeploy.started" : "panel.update.started",
    targetType: "panel",
    targetId: panel.uid,
    traceId: job.trace_id,
    detail: { from: panel.version, to: version },
  });

  return { job, panel };
}

export async function startDelete(
  env: Env,
  config: PublicConfig,
  ctx: StartContext & { panelId: number },
): Promise<StartedJob> {
  const panel = await panelsRepo.findForUser(env, ctx.userId, ctx.panelId);
  if (!panel) throw new AppError("NOT_FOUND", "پنل موردنظر پیدا نشد.");
  if (panel.status === "deleted") throw new AppError("CONFLICT", "این پنل قبلاً حذف شده است.");
  await assertPanelIdle(env, panel.id);

  const job = await jobsRepo.create(env, {
    id: uuid(),
    userId: ctx.userId,
    panelId: panel.id,
    accountRef: panel.account_ref,
    kind: "delete",
    payload: {
      workerName: panel.worker_name,
      databaseName: panel.d1_database_name,
      version: panel.version ?? "",
      accountRef: panel.account_ref,
      cloudflareAccountId: panel.cloudflare_account_id,
      d1DatabaseId: panel.d1_database_id ?? undefined,
    } satisfies InstallPayload,
    traceId: trace(ctx),
    telegramChatId: ctx.telegramChatId,
    steps: stepNames("delete"),
  });

  await panelsRepo.updateStatus(env, panel.id, "deleting");
  await auditRepo.record(env, {
    actorType: "telegram_user",
    actorId: ctx.userId,
    action: "panel.delete.started",
    targetType: "panel",
    targetId: panel.uid,
    severity: "warning",
    traceId: job.trace_id,
  });

  return { job, panel };
}

export async function startBackup(
  env: Env,
  config: PublicConfig,
  ctx: StartContext & { panelId: number },
): Promise<{ job: Job; backupId: number }> {
  const panel = await panelsRepo.findForUser(env, ctx.userId, ctx.panelId);
  if (!panel) throw new AppError("NOT_FOUND", "پنل موردنظر پیدا نشد.");
  await assertCanBackup(env, ctx.userId);
  await assertPanelIdle(env, panel.id);
  await assertGlobalCapacity(env);

  const backupId = await panelsRepo.createBackup(env, panel.id, ctx.userId);
  const job = await jobsRepo.create(env, {
    id: uuid(),
    userId: ctx.userId,
    panelId: panel.id,
    accountRef: panel.account_ref,
    kind: "backup",
    payload: {
      workerName: panel.worker_name,
      databaseName: panel.d1_database_name,
      version: panel.version ?? "",
      accountRef: panel.account_ref,
      cloudflareAccountId: panel.cloudflare_account_id,
      d1DatabaseId: panel.d1_database_id ?? undefined,
      backupId,
    } satisfies InstallPayload,
    traceId: trace(ctx),
    telegramChatId: ctx.telegramChatId,
    steps: stepNames("backup"),
  });

  await auditRepo.record(env, {
    actorType: "telegram_user",
    actorId: ctx.userId,
    action: "panel.backup.started",
    targetType: "panel",
    targetId: panel.uid,
    traceId: job.trace_id,
  });

  return { job, backupId };
}

export async function startRestore(
  env: Env,
  config: PublicConfig,
  ctx: StartContext & { panelId: number; backupId: number },
): Promise<{ job: Job }> {
  const panel = await panelsRepo.findForUser(env, ctx.userId, ctx.panelId);
  if (!panel) throw new AppError("NOT_FOUND", "پنل موردنظر پیدا نشد.");
  await assertCanBackup(env, ctx.userId);
  await assertPanelIdle(env, panel.id);
  await assertGlobalCapacity(env);

  const entitlements = await assertCanBackup(env, ctx.userId);
  const backup = await panelsRepo.findBackup(env, ctx.backupId, ctx.userId);
  if (!backup || backup.panel_id !== panel.id || backup.status !== "completed" || !backup.object_key) {
    throw new AppError("NOT_FOUND", "نسخهٔ پشتیبان معتبر برای این پنل پیدا نشد.");
  }
  if (entitlements.maxBackupBytes > 0 && Number(backup.size_bytes ?? 0) > entitlements.maxBackupBytes) {
    throw new AppError(
      "LIMIT_REACHED",
      `حجم این پشتیبان (${humanBytes(backup.size_bytes)}) از سقف پلن شما (${humanBytes(entitlements.maxBackupBytes)}) بیشتر است.`,
    );
  }

  const job = await jobsRepo.create(env, {
    id: uuid(),
    userId: ctx.userId,
    panelId: panel.id,
    accountRef: panel.account_ref,
    kind: "restore",
    payload: {
      workerName: panel.worker_name,
      databaseName: panel.d1_database_name,
      version: panel.version ?? "",
      accountRef: panel.account_ref,
      cloudflareAccountId: panel.cloudflare_account_id,
      d1DatabaseId: panel.d1_database_id ?? undefined,
      backupId: backup.id,
      restoreObjectKey: backup.object_key,
    } satisfies InstallPayload,
    traceId: trace(ctx),
    telegramChatId: ctx.telegramChatId,
    steps: stepNames("restore"),
  });

  await auditRepo.record(env, {
    actorType: "telegram_user",
    actorId: ctx.userId,
    action: "panel.restore.started",
    targetType: "panel",
    targetId: panel.uid,
    severity: "warning",
    traceId: job.trace_id,
    detail: { backupId: backup.id },
  });

  return { job };
}

/**
 * Persists backfill data for legacy panels: regenerates the display URL from the
 * account's workers.dev subdomain. Safe to call repeatedly.
 */
export async function resolvePanelUrl(env: Env, panel: Panel): Promise<string | null> {
  if (panel.panel_url) return panel.panel_url;
  const account = await accountsRepo.findForUser(env, panel.user_id, panel.account_ref);
  if (!account?.workers_subdomain) return null;
  return `https://${panel.worker_name}.${account.workers_subdomain}.workers.dev/panel`;
}

/** Cancel a job on behalf of its owner (or an admin) and report the outcome. */
export async function cancelJob(env: Env, jobId: string, userId?: number): Promise<boolean> {
  const cancelled = await jobsRepo.cancel(env, jobId, userId);
  if (cancelled) {
    const job = await jobsRepo.findById(env, jobId);
    if (job?.panel_id) {
      await panelsRepo.updateStatus(env, job.panel_id, job.kind === "install" ? "failed" : "active", "لغو توسط کاربر");
    }
    await auditRepo.record(env, {
      actorType: userId ? "telegram_user" : "system",
      actorId: userId ?? null,
      action: "job.cancelled",
      targetType: "job",
      targetId: jobId,
      severity: "warning",
    });
  }
  return cancelled;
}

export { toAppError, recoveryKey };
