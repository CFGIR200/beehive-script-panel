/**
 * Job executor.
 *
 * One pass = at most one step. Passes are triggered by the Telegram webhook
 * (`waitUntil`, time-boxed), by the cron trigger every minute, or by an admin
 * "run now" action. Because the cursor lives in D1 the same job can be advanced
 * by any invocation, and the lease guarantees only one invocation works on it.
 */

import type { Env, PublicConfig } from "../config/env";
import { JOB_LEASE_MS, JOB_STEP_TIMEOUT_MS } from "../config/constants";
import * as jobsRepo from "../database/repositories/jobs";
import type { Job, Step } from "../database/repositories/jobs";
import * as panelsRepo from "../database/repositories/panels";
import { loadConnection } from "../auth/cloudflare-auth";
import { createArtifactStore } from "../panels/artifact";
import { AppError, toAppError } from "../utils/errors";
import { createLogger } from "../utils/logger";
import { stepForJob, type InstallPayload, type JobContext } from "./steps";
import { rollback } from "./rollback";
import { reportJobProgress } from "./progress";
import { now } from "../utils/time";
import { randomToken } from "../utils/ids";

export interface PassResult {
  jobId: string;
  outcome: "advanced" | "completed" | "failed" | "rolled_back" | "skipped" | "retry";
  step?: string;
  message?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new AppError("CF_TIMEOUT", "اجرای این مرحله زمان‌بر شد.", { detail: `${label} timeout` })), ms),
    ),
  ]);
}

/** Builds the job context: decrypted connection, artifact store, merge checkpoint. */
async function buildContext(
  env: Env,
  config: PublicConfig,
  job: Job,
  logger: ReturnType<typeof createLogger>,
): Promise<JobContext> {
  if (!job.panel_id || !job.account_ref) {
    throw new AppError("INTERNAL", "job is not bound to a panel/account", {
      detail: `panel=${job.panel_id} account=${job.account_ref}`,
    });
  }
  const panel = await panelsRepo.findById(env, job.panel_id);
  if (!panel) throw new AppError("NOT_FOUND", "panel row missing for this job");

  const connection = await loadConnection(env, config, job.user_id, job.account_ref, job.trace_id);
  const payload = jobsRepo.payloadOf<InstallPayload>(job);

  const ctx: JobContext = {
    env,
    config,
    logger,
    job,
    panel,
    account: connection.account,
    client: connection.client,
    artifacts: createArtifactStore(env, config),
    payload,
    async merge(patch: Partial<InstallPayload>): Promise<void> {
      const merged = { ...payload, ...patch } as InstallPayload;
      Object.assign(payload, merged);
      await jobsRepo.updatePayload(env, job.id, merged as unknown as Record<string, unknown>);
    },
  };
  return ctx;
}

/** Runs the next pending step for a job that this invocation has leased. */
export async function executePass(
  env: Env,
  config: PublicConfig,
  jobId: string,
  options: { owner?: string } = {},
): Promise<PassResult> {
  const owner = options.owner ?? `pass_${randomToken(8)}`;
  const job = await jobsRepo.findById(env, jobId);
  if (!job) return { jobId, outcome: "skipped", message: "job not found" };
  if (jobsRepo.isTerminal(job.status)) return { jobId, outcome: "skipped", message: "job already finished" };

  const logger = createLogger({ traceId: job.trace_id, scope: "executor" });

  const leased = await jobsRepo.renewLease(env, jobId, job.lease_owner ?? owner, JOB_LEASE_MS);
  if (!leased) {
    // Someone else holds the lease (or it was never taken by us): take it now.
    const taken = await jobsRepo.leaseNext(env, owner, JOB_LEASE_MS);
    if (!taken || taken.id !== jobId) {
      return { jobId, outcome: "skipped", message: "job is leased by another invocation" };
    }
  }

  const steps = await jobsRepo.steps(env, jobId);
  const next = steps.find((step) => step.status === "pending" || step.status === "failed" || step.status === "running");
  if (!next) {
    await jobsRepo.complete(env, jobId, jobsRepo.resultOf(job) ?? {});
    await jobsRepo.releaseLease(env, jobId);
    return { jobId, outcome: "completed" };
  }

  let ctx: JobContext;
  try {
    ctx = await buildContext(env, config, job, logger);
  } catch (error) {
    const appError = toAppError(error);
    logger.error("cannot build job context", { code: appError.code, detail: appError.detail });
    await jobsRepo.finishStep(env, jobId, next.seq, "failed", appError.userMessage, appError.code);
    await jobsRepo.fail(env, jobId, appError.code, appError.userMessage);
    await jobsRepo.releaseLease(env, jobId);
    await reportJobProgress(env, config, jobId).catch(() => {});
    return { jobId, outcome: "failed", step: next.name, message: appError.userMessage };
  }

  await jobsRepo.startStep(env, jobId, next.seq);
  await jobsRepo.setStatus(env, jobId, phaseStatus(job.kind, next.name), next.name);

  try {
    const step = stepForJob(job, next.name);
    const outcome = await withTimeout(step(ctx), JOB_STEP_TIMEOUT_MS, next.name);
    await jobsRepo.finishStep(env, jobId, next.seq, "done", outcome.message);

    const remaining = steps.filter((step) => step.seq > next.seq && step.status === "pending");
    if (remaining.length === 0) {
      const fresh = await jobsRepo.findById(env, jobId);
      const result = buildResult(ctx, fresh);
      await jobsRepo.complete(env, jobId, result);
      await jobsRepo.releaseLease(env, jobId);
      await reportJobProgress(env, config, jobId).catch(() => {});
      return { jobId, outcome: "completed", step: next.name, message: outcome.message };
    }

    await jobsRepo.releaseLease(env, jobId);
    await reportJobProgress(env, config, jobId).catch(() => {});
    return { jobId, outcome: "advanced", step: next.name, message: outcome.message };
  } catch (error) {
    const appError = toAppError(error);
    logger.error("step failed", {
      step: next.name,
      code: appError.code,
      detail: appError.detail,
      retryable: appError.retryable,
    });
    await jobsRepo.finishStep(env, jobId, next.seq, "failed", appError.userMessage, appError.code);

    const canRetry = appError.retryable && !(await jobsRepo.exhausted(env, (await jobsRepo.findById(env, jobId)) ?? job));
    if (canRetry) {
      await jobsRepo.fail(env, jobId, appError.code, appError.userMessage, false);
      await jobsRepo.releaseLease(env, jobId);
      await reportJobProgress(env, config, jobId).catch(() => {});
      return { jobId, outcome: "retry", step: next.name, message: appError.userMessage };
    }

    // Deterministic failure: roll back whatever this job created.
    const report = await rollback(ctx, next.name);
    await jobsRepo.fail(env, jobId, appError.code, appError.userMessage, true);
    await jobsRepo.releaseLease(env, jobId);
    await reportJobProgress(env, config, jobId).catch(() => {});
    void report;

    return { jobId, outcome: "rolled_back", step: next.name, message: appError.userMessage };
  }
}

function phaseStatus(kind: Job["kind"], stepName: string): jobsRepo.JobStatus {
  if (stepName === "validate_account" || stepName === "preflight") return "validating";
  if (stepName === "upload_worker" || stepName.startsWith("delete_")) return "deploying";
  if (stepName === "verify_endpoint" || stepName === "finalize" || stepName === "mark_deleted" || stepName === "health_check") {
    return "verifying";
  }
  if (kind === "install") return "provisioning";
  return "configuring";
}

function buildResult(ctx: JobContext, job: Job | null): Record<string, unknown> {
  const payload = job ? jobsRepo.payloadOf<InstallPayload>(job) : ctx.payload;
  return {
    panelUid: ctx.panel.uid,
    workerName: payload.workerName ?? ctx.panel.worker_name,
    panelUrl: payload.panelUrl ?? ctx.panel.panel_url,
    version: payload.version ?? ctx.panel.version,
    databaseName: payload.databaseName ?? ctx.panel.d1_database_name,
    artifactSha256: payload.artifactSha256 ?? ctx.panel.artifact_sha256,
    backupObjectKey: payload.restoreObjectKey ?? null,
  };
}

/**
 * Drains runnable jobs for a time budget. Called from cron and from the webhook
 * kick. Returns the per-job outcomes so the caller can log a summary.
 */
export async function drain(
  env: Env,
  config: PublicConfig,
  budgetMs = config.jobSliceMs,
): Promise<PassResult[]> {
  const started = now();
  const results: PassResult[] = [];
  const owner = `drain_${randomToken(6)}`;

  while (now() - started < budgetMs) {
    const job = await jobsRepo.leaseNext(env, owner, JOB_LEASE_MS);
    if (!job) break;
    const result = await executePass(env, config, job.id, { owner });
    results.push(result);
    if (result.outcome === "skipped") break;
    // A single invocation must not monopolise the isolate: cap steps per pass.
    if (results.length >= 12) break;
  }
  return results;
}

/** Advances one specific job until it finishes or the budget runs out. */
export async function runJobToCompletion(
  env: Env,
  config: PublicConfig,
  jobId: string,
  budgetMs = config.jobSliceMs,
): Promise<PassResult> {
  const started = now();
  let last: PassResult = { jobId, outcome: "skipped" };
  while (now() - started < budgetMs) {
    last = await executePass(env, config, jobId);
    if (last.outcome !== "advanced" && last.outcome !== "retry") break;
  }
  return last;
}

export function stepLabel(step: Step | undefined): string {
  return step?.name ?? "—";
}
