/**
 * Plan limits.
 *
 * Every limit is read from `subscription_plans` at call time — there is no
 * hard-coded per-feature ceiling anywhere else in the codebase. `-1` means
 * unlimited; hard operational caps from HARD_LIMITS still apply on top.
 */

import type { Env } from "../config/env";
import type { Plan } from "../database/repositories/subscriptions";
import * as subsRepo from "../database/repositories/subscriptions";
import * as panelsRepo from "../database/repositories/panels";
import * as accountsRepo from "../database/repositories/accounts";
import * as jobsRepo from "../database/repositories/jobs";
import * as settingsRepo from "../database/repositories/settings";
import { HARD_LIMITS } from "../config/constants";
import { AppError, messages } from "../utils/errors";

export interface Entitlements {
  plan: Plan;
  panelsUsed: number;
  maxPanels: number;
  accountsUsed: number;
  maxAccounts: number;
  activeJobs: number;
  maxConcurrentJobs: number;
  canInstall: boolean;
  canUpdate: boolean;
  canBackup: boolean;
  canCustomDomain: boolean;
  maxBackupBytes: number;
  expiresAt: number | null;
}

function cap(value: number, hard: number): number {
  if (value < 0) return hard;
  return Math.min(value, hard);
}

export async function entitlementsFor(env: Env, userId: number): Promise<Entitlements> {
  const subscription = await subsRepo.activeSubscription(env, userId);
  const defaultPlan = (await settingsRepo.get(env, "default_plan", "free")) ?? "free";
  const plan = (subscription ? await subsRepo.findPlan(env, subscription.plan_code) : null) ?? (await subsRepo.findPlan(env, defaultPlan));

  if (!plan) {
    throw new AppError("CONFIG", "پلن پیش‌فرض سیستم تعریف نشده است.", { detail: `plan ${defaultPlan} missing` });
  }

  const [panelsUsed, accountsUsed, activeJobs] = await Promise.all([
    panelsRepo.countForUser(env, userId),
    accountsRepo.countForUser(env, userId),
    jobsRepo.activeJobCountForUser(env, userId),
  ]);

  const installEnabled = await settingsRepo.getBool(env, "install_enabled", true);

  return {
    plan,
    panelsUsed,
    maxPanels: cap(plan.max_panels, HARD_LIMITS.maxPanelsPerUser),
    accountsUsed,
    maxAccounts: cap(plan.max_accounts, HARD_LIMITS.maxAccountsPerUser),
    activeJobs,
    maxConcurrentJobs: Math.max(1, cap(plan.max_concurrent_jobs, 8)),
    canInstall: installEnabled && plan.is_active === 1,
    canUpdate: plan.allow_update === 1,
    canBackup: plan.allow_backup === 1,
    canCustomDomain: plan.allow_custom_domain === 1,
    maxBackupBytes: plan.max_backup_bytes,
    expiresAt: subscription?.expires_at ?? null,
  };
}

export async function assertCanAddAccount(env: Env, userId: number): Promise<Entitlements> {
  const entitlements = await entitlementsFor(env, userId);
  if (entitlements.accountsUsed >= entitlements.maxAccounts) {
    throw new AppError("LIMIT_REACHED", messages.limitReached, {
      detail: `accounts ${entitlements.accountsUsed}/${entitlements.maxAccounts}`,
    });
  }
  return entitlements;
}

export async function assertCanInstall(env: Env, userId: number): Promise<Entitlements> {
  const entitlements = await entitlementsFor(env, userId);
  if (!entitlements.canInstall) {
    throw new AppError("FORBIDDEN", "نصب پنل جدید در حال حاضر غیرفعال است.", { detail: "install disabled" });
  }
  if (entitlements.panelsUsed >= entitlements.maxPanels) {
    throw new AppError("LIMIT_REACHED", messages.limitReached, {
      detail: `panels ${entitlements.panelsUsed}/${entitlements.maxPanels}`,
    });
  }
  if (entitlements.activeJobs >= entitlements.maxConcurrentJobs) {
    throw new AppError("LIMIT_REACHED", "یک عملیات دیگر در حال اجراست؛ بعد از پایان آن دوباره تلاش کنید.", {
      detail: `jobs ${entitlements.activeJobs}/${entitlements.maxConcurrentJobs}`,
    });
  }
  return entitlements;
}

export async function assertCanUpdate(env: Env, userId: number): Promise<Entitlements> {
  const entitlements = await entitlementsFor(env, userId);
  if (!entitlements.canUpdate) {
    throw new AppError("FORBIDDEN", messages.updateNotAllowed, { detail: "plan disallows update" });
  }
  if (entitlements.activeJobs >= entitlements.maxConcurrentJobs) {
    throw new AppError("LIMIT_REACHED", "یک عملیات دیگر در حال اجراست.", { detail: "concurrency" });
  }
  return entitlements;
}

export async function assertCanBackup(env: Env, userId: number): Promise<Entitlements> {
  const entitlements = await entitlementsFor(env, userId);
  if (!entitlements.canBackup) {
    throw new AppError("FORBIDDEN", messages.backupNotAllowed, { detail: "plan disallows backup" });
  }
  if (entitlements.activeJobs >= entitlements.maxConcurrentJobs) {
    throw new AppError("LIMIT_REACHED", "یک عملیات دیگر در حال اجراست.", { detail: "concurrency" });
  }
  return entitlements;
}

/** Human-readable limit lines for the subscription screen. */
export function describeLimits(entitlements: Entitlements): string[] {
  const unlimited = (value: number) => value >= HARD_LIMITS.maxPanelsPerUser || value < 0;
  return [
    `تعداد پنل: ${unlimited(entitlements.maxPanels) ? "بدون محدودیت" : entitlements.maxPanels}`,
    `تعداد حساب Cloudflare: ${unlimited(entitlements.maxAccounts) ? "بدون محدودیت" : entitlements.maxAccounts}`,
    `عملیات هم‌زمان: ${entitlements.maxConcurrentJobs}`,
    `به‌روزرسانی پنل: ${entitlements.canUpdate ? "فعال" : "غیرفعال"}`,
    `پشتیبان‌گیری: ${entitlements.canBackup ? "فعال" : "غیرفعال"}`,
    `دامنهٔ اختصاصی: ${entitlements.canCustomDomain ? "فعال" : "غیرفعال"}`,
  ];
}
