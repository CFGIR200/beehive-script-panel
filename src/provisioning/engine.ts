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
import * as usersRepo from "../database/repositories/users";
import { stepNames } from "./planner";
import type { InstallPayload } from "./steps";
import { drain } from "./executor";
import { assertCanBackup, assertCanInstall, assertCanUpdate, entitlementsFor, type Entitlements } from "../subscriptions/limits";
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

/** Shared tail of startUpdate/startUpdateBatch: record the job, flip status, audit. */
async function queueUpdateJob(
  env: Env,
  panel: Panel,
  opts: {
    kind: "update" | "redeploy";
    version: string;
    actorType: "telegram_user" | "system";
    actorId: number | null;
    telegramChatId: number | null;
  },
): Promise<Job> {
  const job = await jobsRepo.create(env, {
    id: uuid(),
    userId: panel.user_id,
    panelId: panel.id,
    accountRef: panel.account_ref,
    kind: opts.kind,
    payload: {
      workerName: panel.worker_name,
      databaseName: panel.d1_database_name,
      version: opts.version,
      accountRef: panel.account_ref,
      cloudflareAccountId: panel.cloudflare_account_id,
      d1DatabaseId: panel.d1_database_id ?? undefined,
      subdomain: undefined,
      previousVersion: panel.version ?? undefined,
      previousSha: panel.artifact_sha256 ?? undefined,
    } satisfies InstallPayload,
    traceId: traceId(),
    telegramChatId: opts.telegramChatId,
    steps: stepNames(opts.kind),
  });

  await panelsRepo.updateStatus(env, panel.id, "updating");
  await auditRepo.record(env, {
    actorType: opts.actorType,
    actorId: opts.actorId,
    action: opts.kind === "redeploy" ? "panel.redeploy.started" : "panel.update.started",
    targetType: "panel",
    targetId: panel.uid,
    traceId: job.trace_id,
    detail: { from: panel.version, to: opts.version },
  });
  return job;
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
  if (!ctx.redeploy && panel.version === version && isCurrentBuild(panel, registered)) {
    throw new AppError("CONFLICT", `پنل از قبل روی نسخهٔ ${version} است.`);
  }

  const job = await queueUpdateJob(env, panel, {
    kind: ctx.redeploy ? "redeploy" : "update",
    version,
    actorType: "telegram_user",
    actorId: ctx.userId,
    telegramChatId: ctx.telegramChatId,
  });

  return { job, panel };
}

// ---- bulk update -----------------------------------------------------------

/**
 * A panel is on the approved build only when BOTH the version string and the
 * recorded build digest match. The patched and unpatched builds of 3.1.13
 * share one version string — without the digest check, panels still running
 * the original vendor bundle would be considered current forever and never
 * receive the BEEHIVE-patched artifact.
 */
function isCurrentBuild(panel: { version: string | null; artifact_sha256: string | null }, registered: { version: string; artifact_sha256: string | null }): boolean {
  if (panel.version !== registered.version) return false;
  const target = (registered.artifact_sha256 ?? "").toLowerCase();
  if (!target) return true; // registry without a digest: fall back to version-only
  return ((panel.artifact_sha256 ?? "").toLowerCase()) === target;
}

export type UpdateSkipReason = "missing" | "busy" | "current" | "plan" | "concurrency" | "capacity";

export interface UpdateBatchResult {
  queued: Array<{ panelId: number; workerName: string; jobId: string }>;
  skipped: Array<{ panelId: number; workerName: string; reason: UpdateSkipReason }>;
  /** true when the global concurrency cap stopped the batch early. */
  capacityReached: boolean;
}

/**
 * Queues an update job for every given panel that can accept one, without
 * throwing on individual panels — a bulk "update all opened panels" must not
 * die because one panel is busy. Skips are reported with reasons instead:
 *
 *   missing      — panel gone, deleted, or not in a state that accepts updates
 *   busy         — another job is already running for that panel
 *   current      — panel already runs the approved latest version
 *   plan         — owner's plan disallows updates
 *   concurrency  — owner already has their maximum concurrent jobs running
 *   capacity     — global concurrency cap reached; the caller can retry later
 *
 * Data safety matches the single-panel flow exactly: only the Worker script is
 * replaced, the customer D1 database and the baked-in BEEHIVE patches survive.
 */
export async function startUpdateBatch(
  env: Env,
  config: PublicConfig,
  input: {
    panelIds: number[];
    actorType: "telegram_user" | "system";
    actorId: number | null;
    /** Chat that receives per-job progress; null → each panel owner's own chat. */
    telegramChatId?: number | null;
  },
): Promise<UpdateBatchResult> {
  const logger = createLogger({ scope: "engine.updateBatch", traceId: traceId() });
  const result: UpdateBatchResult = { queued: [], skipped: [], capacityReached: false };

  const version = config.artifactVersion;
  const registered = await panelsRepo.findVersion(env, version);
  if (!registered || !registered.is_active) {
    throw new AppError("ARTIFACT_MISSING", `نسخهٔ ${version} پنل در دسترس نیست.`);
  }

  const [active, limit] = await Promise.all([
    jobsRepo.activeJobCount(env),
    settingsRepo.getInt(env, "max_global_concurrency", 6),
  ]);
  let slots = Math.max(0, limit - active);

  const entitlementsByOwner = new Map<number, Entitlements>();
  const ownerChatByOwner = new Map<number, number | null>();
  const queuedPerOwner = new Map<number, number>();

  for (const panelId of input.panelIds) {
    if (slots <= 0) {
      result.capacityReached = true;
      const panel = await panelsRepo.findById(env, panelId);
      result.skipped.push({ panelId, workerName: panel?.worker_name ?? "—", reason: "capacity" });
      continue;
    }

    const panel = await panelsRepo.findById(env, panelId);
    if (!panel || panel.status !== "active") {
      result.skipped.push({ panelId, workerName: panel?.worker_name ?? "—", reason: "missing" });
      continue;
    }
    if (isCurrentBuild(panel, registered)) {
      result.skipped.push({ panelId, workerName: panel.worker_name, reason: "current" });
      continue;
    }
    if (await jobsRepo.activeJobForPanel(env, panel.id)) {
      result.skipped.push({ panelId, workerName: panel.worker_name, reason: "busy" });
      continue;
    }

    let entitlements = entitlementsByOwner.get(panel.user_id);
    if (!entitlements) {
      try {
        entitlements = await assertCanUpdate(env, panel.user_id);
      } catch {
        // Plan/concurrency limit hit: load entitlements anyway so the skip
        // reason (plan vs concurrency) can be reported precisely.
        entitlements = await entitlementsFor(env, panel.user_id);
      }
      entitlementsByOwner.set(panel.user_id, entitlements);
    }
    if (!entitlements.canUpdate) {
      result.skipped.push({ panelId, workerName: panel.worker_name, reason: "plan" });
      continue;
    }
    const alreadyQueued = queuedPerOwner.get(panel.user_id) ?? 0;
    if (entitlements.activeJobs + alreadyQueued >= entitlements.maxConcurrentJobs) {
      result.skipped.push({ panelId, workerName: panel.worker_name, reason: "concurrency" });
      continue;
    }

    let ownerChat = input.telegramChatId;
    if (ownerChat == null) {
      if (!ownerChatByOwner.has(panel.user_id)) {
        const owner = await usersRepo.findById(env, panel.user_id);
        ownerChatByOwner.set(panel.user_id, owner?.telegram_id ?? null);
      }
      ownerChat = ownerChatByOwner.get(panel.user_id) ?? null;
    }

    try {
      const job = await queueUpdateJob(env, panel, {
        kind: "update",
        version,
        actorType: input.actorType,
        actorId: input.actorId,
        telegramChatId: ownerChat,
      });
      slots -= 1;
      queuedPerOwner.set(panel.user_id, alreadyQueued + 1);
      result.queued.push({ panelId: panel.id, workerName: panel.worker_name, jobId: job.id });
    } catch (error) {
      // Race with another enqueue (global capacity, idle check): report, keep going.
      logger.warn("batch enqueue failed", { panelId: panel.id, error });
      result.skipped.push({ panelId: panel.id, workerName: panel.worker_name, reason: "capacity" });
    }
  }

  if (result.queued.length > 0) {
    await auditRepo.record(env, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: "panel.update.batch_started",
      targetType: "panel_versions",
      targetId: version,
      detail: {
        queued: result.queued.length,
        skipped: result.skipped.reduce<Record<string, number>>((acc, item) => {
          acc[item.reason] = (acc[item.reason] ?? 0) + 1;
          return acc;
        }, {}),
        capacityReached: result.capacityReached,
      },
    });
  }

  logger.info("update batch finished", { queued: result.queued.length, skipped: result.skipped.length });
  return result;
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
