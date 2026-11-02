/**
 * Telegram progress reporting for jobs.
 *
 * The job row stores the chat id and message id of its progress message, so
 * every invocation (webhook, cron, dashboard action) edits the same message
 * instead of spamming the chat. Failures to edit are logged and ignored —
 * progress reporting must never fail a job.
 */

import type { Env, PublicConfig } from "../config/env";
import * as jobsRepo from "../database/repositories/jobs";
import * as panelsRepo from "../database/repositories/panels";
import { TelegramClient } from "../bot/telegram";
import { fa } from "../bot/messages";
import { jobKeyboard } from "../bot/keyboards";
import { createLogger } from "../utils/logger";
import { formatDurationFa } from "../utils/time";
import { humanBytes } from "../panels/artifact";

const JOB_TITLES: Record<string, string> = {
  install: "نصب پنل",
  update: "به‌روزرسانی پنل",
  redeploy: "نصب مجدد پنل",
  delete: "حذف پنل",
  backup: "پشتیبان‌گیری",
  restore: "بازیابی پشتیبان",
  health: "بررسی سلامت",
};

export function jobTitle(kind: string): string {
  return JOB_TITLES[kind] ?? kind;
}

export async function reportJobProgress(env: Env, config: PublicConfig, jobId: string): Promise<void> {
  const job = await jobsRepo.findById(env, jobId);
  if (!job || !job.telegram_chat_id) return;

  const logger = createLogger({ traceId: job.trace_id, scope: "progress" });
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, { traceId: job.trace_id });
  const steps = await jobsRepo.steps(env, jobId);
  const current = steps.find((step) => step.name === job.current_step) ?? steps.find((step) => step.status !== "done");

  try {
    if (job.status === "completed") {
      const result = jobsRepo.resultOf<{ workerName?: string; panelUrl?: string; version?: string; databaseName?: string }>(job);
      if (job.kind === "install" && result?.panelUrl) {
        const panel = job.panel_id ? await panelsRepo.findById(env, job.panel_id) : null;
        const payload = jobsRepo.payloadOf<{ recoveryKey?: string }>(job);
        const text = fa.installDone({
          url: result.panelUrl,
          workerName: result.workerName ?? panel?.worker_name ?? "—",
          recoveryKey: payload.recoveryKey ?? "—",
          dbName: result.databaseName ?? panel?.d1_database_name ?? "—",
          version: result.version ?? panel?.version ?? "—",
        });
        await sendOrEdit(env, telegram, job, text, { parse_mode: "HTML", reply_markup: jobKeyboard(job.id) });
        // The recovery key is secret: instruct the user, then strip it from the job payload.
        await jobsRepo.updatePayload(env, job.id, { ...jobsRepo.payloadOf(job), recoveryKey: undefined });
        return;
      }
      if (job.kind === "backup") {
        const payload = jobsRepo.payloadOf<{ backupBytes?: number; backupId?: number }>(job);
        const text = fa.backupDone({
          size: humanBytes(payload.backupBytes ?? 0),
          backupId: String(payload.backupId ?? "—"),
        });
        await sendOrEdit(env, telegram, job, `${fa.jobCompleted(jobTitle(job.kind))}\n\n${text}`, {
          parse_mode: "HTML",
          reply_markup: jobKeyboard(job.id),
        });
        return;
      }
      if (job.kind === "delete") {
        const panel = job.panel_id ? await panelsRepo.findById(env, job.panel_id) : null;
        await sendOrEdit(env, telegram, job, fa.deleteDone(panel?.worker_name ?? "—"), { parse_mode: "HTML" });
        return;
      }
      await sendOrEdit(env, telegram, job, fa.jobCompleted(jobTitle(job.kind)), { parse_mode: "HTML" });
      return;
    }

    if (job.status === "failed" || job.status === "rolled_back" || job.status === "rollback_required") {
      const panel = job.panel_id ? await panelsRepo.findById(env, job.panel_id) : null;
      const base = fa.jobFailed({
        title: jobTitle(job.kind),
        message: job.error_message ?? "خطای نامشخص",
        traceId: job.trace_id,
      });
      const rolledBack = job.status === "rolled_back" ? "\n\n♻️ منابع ساخته‌شده در این عملیات حذف شدند." : "";
      const needsManual = panel?.status_reason && job.status === "rollback_required" ? `\n\n${panel.status_reason}` : "";
      await sendOrEdit(env, telegram, job, `${base}${rolledBack}${needsManual}`, { parse_mode: "HTML" });
      return;
    }

    const text = fa.jobProgress({
      title: jobTitle(job.kind),
      status: statusLabel(job.status),
      currentStep: fa.stepLabels[current?.name ?? job.current_step ?? ""] ?? current?.name ?? "در حال آماده‌سازی",
      done: job.steps_done,
      total: job.steps_total,
      elapsed: formatDurationFa(Date.now() - job.created_at),
      traceId: job.trace_id,
    });
    await sendOrEdit(env, telegram, job, text, { parse_mode: "HTML", reply_markup: jobKeyboard(job.id) });
  } catch (error) {
    logger.warn("progress report failed", { error });
  }
}

async function sendOrEdit(
  env: Env,
  telegram: TelegramClient,
  job: { id: string; telegram_chat_id: number | null; telegram_message_id: number | null },
  text: string,
  options: { parse_mode?: "HTML"; reply_markup?: ReturnType<typeof jobKeyboard> },
): Promise<void> {
  if (!job.telegram_chat_id) return;
  if (job.telegram_message_id) {
    try {
      await telegram.editMessageText(job.telegram_chat_id, job.telegram_message_id, text, options);
      return;
    } catch {
      // Editing can fail when the text is unchanged or the message is too old;
      // fall through and send a fresh message.
    }
  }
  const sent = await telegram.sendMessage(job.telegram_chat_id, text, options);
  await jobsRepo.setTelegramMessage(env, job.id, sent.chat.id, sent.message_id);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "در انتظار اجرا",
    validating: "در حال بررسی",
    provisioning: "در حال ساخت منابع",
    configuring: "در حال تنظیم",
    deploying: "در حال استقرار",
    verifying: "در حال بررسی نهایی",
    completed: "پایان‌یافته",
    failed: "ناموفق",
    cancelled: "لغو‌شده",
    rollback_required: "نیازمند بازگردانی دستی",
    rolled_back: "بازگردانی شد",
  };
  return labels[status] ?? status;
}
