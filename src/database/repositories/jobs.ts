/**
 * Resumable job store.
 *
 * A job is a row plus an ordered set of steps. The executor leases a job
 * (`locked_until`), runs one step, persists the outcome, and releases the lease.
 * Because every step is idempotent and the cursor lives in D1, an interrupted
 * job resumes on the next cron tick or webhook kick without duplicating work.
 */

import type { Env } from "../../config/env";
import { all, jsonColumn, one, run, scalar, toJson, type Pagination } from "../db";
import { now } from "../../utils/time";
import { JOB_MAX_ATTEMPTS } from "../../config/constants";

export type JobKind = "install" | "update" | "redeploy" | "delete" | "backup" | "restore" | "health";

export type JobStatus =
  | "pending"
  | "validating"
  | "provisioning"
  | "configuring"
  | "deploying"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"
  | "rollback_required"
  | "rolled_back";

export const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled", "rolled_back"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface Job {
  id: string;
  user_id: number;
  panel_id: number | null;
  account_ref: number | null;
  kind: JobKind;
  status: JobStatus;
  current_step: string | null;
  steps_total: number;
  steps_done: number;
  attempt: number;
  max_attempts: number;
  payload: string;
  result: string | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  lease_owner: string | null;
  locked_until: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface Step {
  id: number;
  job_id: string;
  seq: number;
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  message: string | null;
  error_code: string | null;
  started_at: number | null;
  finished_at: number | null;
  attempts: number;
}

export async function create(env: Env, input: {
  id: string;
  userId: number;
  panelId: number | null;
  accountRef: number | null;
  kind: JobKind;
  payload: Record<string, unknown>;
  traceId: string;
  telegramChatId: number | null;
  steps: string[];
}): Promise<Job> {
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO deployment_jobs
         (id, user_id, panel_id, account_ref, kind, status, steps_total, payload, trace_id,
          telegram_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.id,
      input.userId,
      input.panelId,
      input.accountRef,
      input.kind,
      input.steps.length,
      toJson(input.payload),
      input.traceId,
      input.telegramChatId,
      ts,
      ts,
    ),
    ...input.steps.map((name, index) =>
      env.DB.prepare(
        `INSERT INTO deployment_steps (job_id, seq, name, status) VALUES (?, ?, ?, 'pending')`,
      ).bind(input.id, index, name),
    ),
  ]);
  const job = await findById(env, input.id);
  if (!job) throw new Error("job creation failed");
  return job;
}

export async function findById(env: Env, id: string): Promise<Job | null> {
  return one<Job>(env, "SELECT * FROM deployment_jobs WHERE id = ?", id);
}

export async function findForUser(env: Env, userId: number, id: string): Promise<Job | null> {
  return one<Job>(env, "SELECT * FROM deployment_jobs WHERE id = ? AND user_id = ?", id, userId);
}

export async function steps(env: Env, jobId: string): Promise<Step[]> {
  return all<Step>(env, "SELECT * FROM deployment_steps WHERE job_id = ? ORDER BY seq ASC", jobId);
}

export async function activeJobForPanel(env: Env, panelId: number): Promise<Job | null> {
  return one<Job>(
    env,
    `SELECT * FROM deployment_jobs
      WHERE panel_id = ? AND status NOT IN ('completed','failed','cancelled','rolled_back')
      ORDER BY created_at DESC LIMIT 1`,
    panelId,
  );
}

export async function activeJobCountForUser(env: Env, userId: number): Promise<number> {
  return scalar(
    env,
    `SELECT COUNT(*) FROM deployment_jobs
      WHERE user_id = ? AND status NOT IN ('completed','failed','cancelled','rolled_back')`,
    userId,
  );
}

export async function activeJobCount(env: Env): Promise<number> {
  return scalar(
    env,
    `SELECT COUNT(*) FROM deployment_jobs
      WHERE status NOT IN ('completed','failed','cancelled','rolled_back')`,
  );
}

export async function recentForUser(env: Env, userId: number, limit = 5): Promise<Job[]> {
  return all<Job>(
    env,
    "SELECT * FROM deployment_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    userId,
    limit,
  );
}

export async function listForAdmin(env: Env, page: Pagination, status?: string): Promise<Job[]> {
  if (status) {
    return all<Job>(
      env,
      "SELECT * FROM deployment_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
      status,
      page.limit,
      page.offset,
    );
  }
  return all<Job>(env, "SELECT * FROM deployment_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?", page.limit, page.offset);
}

/**
 * Atomically lease the next runnable job for this worker instance.
 * SQLite (D1) supports RETURNING, so the lease and the read are one statement.
 */
export async function leaseNext(env: Env, owner: string, leaseMs: number): Promise<Job | null> {
  const ts = now();
  return one<Job>(
    env,
    `UPDATE deployment_jobs
        SET lease_owner = ?, locked_until = ?, updated_at = ?
      WHERE id = (
        SELECT id FROM deployment_jobs
         WHERE status NOT IN ('completed','failed','cancelled','rolled_back')
           AND locked_until <= ?
         ORDER BY created_at ASC
         LIMIT 1
      )
      RETURNING *`,
    owner,
    ts + leaseMs,
    ts,
    ts,
  );
}

export async function renewLease(env: Env, jobId: string, owner: string, leaseMs: number): Promise<boolean> {
  const result = await run(
    env,
    "UPDATE deployment_jobs SET locked_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
    now() + leaseMs,
    now(),
    jobId,
    owner,
  );
  return Number(result.meta?.changes ?? 0) > 0;
}

/** Persists the job's working payload — the engine's checkpoint between steps. */
export async function updatePayload(env: Env, jobId: string, payload: Record<string, unknown>): Promise<void> {
  await run(env, "UPDATE deployment_jobs SET payload = ?, updated_at = ? WHERE id = ?", toJson(payload), now(), jobId);
}

export async function releaseLease(env: Env, jobId: string): Promise<void> {
  await run(env, "UPDATE deployment_jobs SET lease_owner = NULL, locked_until = 0 WHERE id = ?", jobId);
}

export async function setStatus(env: Env, jobId: string, status: JobStatus, currentStep?: string | null): Promise<void> {
  if (currentStep !== undefined) {
    await run(
      env,
      "UPDATE deployment_jobs SET status = ?, current_step = ?, updated_at = ? WHERE id = ?",
      status,
      currentStep,
      now(),
      jobId,
    );
    return;
  }
  await run(env, "UPDATE deployment_jobs SET status = ?, updated_at = ? WHERE id = ?", status, now(), jobId);
}

export async function setTelegramMessage(env: Env, jobId: string, chatId: number, messageId: number): Promise<void> {
  await run(
    env,
    "UPDATE deployment_jobs SET telegram_chat_id = ?, telegram_message_id = ?, updated_at = ? WHERE id = ?",
    chatId,
    messageId,
    now(),
    jobId,
  );
}

export async function startStep(env: Env, jobId: string, seq: number): Promise<void> {
  await run(
    env,
    `UPDATE deployment_steps SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE job_id = ? AND seq = ?`,
    now(),
    jobId,
    seq,
  );
}

export async function finishStep(env: Env, jobId: string, seq: number, status: Step["status"], message?: string, errorCode?: string | null): Promise<void> {
  await run(
    env,
    `UPDATE deployment_steps SET status = ?, message = ?, error_code = ?, finished_at = ? WHERE job_id = ? AND seq = ?`,
    status,
    message ?? null,
    errorCode ?? null,
    now(),
    jobId,
    seq,
  );
  if (status === "done" || status === "skipped") {
    await run(env, "UPDATE deployment_jobs SET steps_done = steps_done + 1, updated_at = ? WHERE id = ?", now(), jobId);
  }
}

export async function complete(env: Env, jobId: string, result: Record<string, unknown>): Promise<void> {
  const ts = now();
  await run(
    env,
    `UPDATE deployment_jobs
        SET status = 'completed', result = ?, finished_at = ?, updated_at = ?, locked_until = 0, lease_owner = NULL,
            steps_done = steps_total, current_step = NULL
      WHERE id = ?`,
    toJson(result),
    ts,
    ts,
    jobId,
  );
}

export async function fail(env: Env, jobId: string, code: string, message: string, terminal = true): Promise<void> {
  const ts = now();
  if (terminal) {
    await run(
      env,
      `UPDATE deployment_jobs
          SET status = CASE WHEN status IN ('rollback_required','rolled_back','cancelled') THEN status ELSE 'failed' END,
              error_code = ?, error_message = ?, finished_at = ?, updated_at = ?, locked_until = 0, lease_owner = NULL
        WHERE id = ?`,
      code,
      message.slice(0, 500),
      ts,
      ts,
      jobId,
    );
    return;
  }
  // Retryable failure: bump the attempt counter and let the next pass pick it up.
  await run(
    env,
    `UPDATE deployment_jobs
        SET attempt = attempt + 1, error_code = ?, error_message = ?, updated_at = ?, locked_until = 0, lease_owner = NULL
      WHERE id = ?`,
    code,
    message.slice(0, 500),
    ts,
    jobId,
  );
}

export async function exhausted(env: Env, job: Job): Promise<boolean> {
  return job.attempt + 1 >= Math.min(job.max_attempts, JOB_MAX_ATTEMPTS);
}

export async function requireRollback(env: Env, jobId: string, code: string, message: string): Promise<void> {
  const ts = now();
  await run(
    env,
    `UPDATE deployment_jobs
        SET status = 'rollback_required', error_code = ?, error_message = ?, updated_at = ?,
            locked_until = 0, lease_owner = NULL
      WHERE id = ?`,
    code,
    message.slice(0, 500),
    ts,
    jobId,
  );
}

export async function cancel(env: Env, jobId: string, userId?: number): Promise<boolean> {
  const job = userId === undefined ? await findById(env, jobId) : await findForUser(env, userId, jobId);
  if (!job) return false;
  if (isTerminal(job.status)) return false;
  await setStatus(env, jobId, "cancelled");
  await run(env, "UPDATE deployment_jobs SET finished_at = ?, locked_until = 0, lease_owner = NULL WHERE id = ?", now(), jobId);
  return true;
}

export function payloadOf<T>(job: Job): T {
  return jsonColumn<T>(job.payload, {} as T);
}

export function resultOf<T>(job: Job): T | null {
  if (!job.result) return null;
  return jsonColumn<T | null>(job.result, null);
}

export async function countByStatus(env: Env): Promise<Record<string, number>> {
  const rows = await all<{ status: string; n: number }>(
    env,
    "SELECT status, COUNT(*) AS n FROM deployment_jobs GROUP BY status",
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = Number(row.n);
  return out;
}
