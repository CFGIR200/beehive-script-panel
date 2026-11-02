/** Subscription plans and the subscriptions attached to users. */

import type { Env } from "../../config/env";
import { all, one, run } from "../db";
import { now } from "../../utils/time";

export interface Plan {
  code: string;
  name: string;
  description: string | null;
  price_toman: number;
  duration_days: number;
  max_panels: number;
  max_accounts: number;
  max_concurrent_jobs: number;
  allow_update: number;
  allow_backup: number;
  allow_custom_domain: number;
  max_backup_bytes: number;
  is_active: number;
  sort_order: number;
  updated_at: number;
}

export interface Subscription {
  id: number;
  user_id: number;
  plan_code: string;
  status: "active" | "expired" | "cancelled" | "pending";
  started_at: number;
  expires_at: number | null;
  granted_by: number | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export async function listPlans(env: Env, onlyActive = true): Promise<Plan[]> {
  const where = onlyActive ? "WHERE is_active = 1" : "";
  return all<Plan>(env, `SELECT * FROM subscription_plans ${where} ORDER BY sort_order ASC, price_toman ASC`);
}

export async function findPlan(env: Env, code: string): Promise<Plan | null> {
  return one<Plan>(env, "SELECT * FROM subscription_plans WHERE code = ?", code);
}

export async function updatePlan(env: Env, code: string, patch: Partial<Omit<Plan, "code" | "updated_at">>): Promise<void> {
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(value);
  }
  if (!fields.length) return;
  params.push(now(), code);
  await run(env, `UPDATE subscription_plans SET ${fields.join(", ")}, updated_at = ? WHERE code = ?`, ...params);
}

export async function createPlan(env: Env, plan: Omit<Plan, "updated_at">): Promise<void> {
  await run(
    env,
    `INSERT INTO subscription_plans
       (code, name, description, price_toman, duration_days, max_panels, max_accounts,
        max_concurrent_jobs, allow_update, allow_backup, allow_custom_domain, max_backup_bytes,
        is_active, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    plan.code,
    plan.name,
    plan.description,
    plan.price_toman,
    plan.duration_days,
    plan.max_panels,
    plan.max_accounts,
    plan.max_concurrent_jobs,
    plan.allow_update,
    plan.allow_backup,
    plan.allow_custom_domain,
    plan.max_backup_bytes,
    plan.is_active,
    plan.sort_order,
    now(),
  );
}

export async function activeSubscription(env: Env, userId: number): Promise<Subscription | null> {
  return one<Subscription>(
    env,
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1",
    userId,
  );
}

export async function historyForUser(env: Env, userId: number, limit = 10): Promise<Subscription[]> {
  return all<Subscription>(
    env,
    "SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    userId,
    limit,
  );
}

/**
 * Grants a plan. Any previously active subscription is cancelled in the same
 * batch so the partial unique index (one active row per user) never trips.
 */
export async function grant(env: Env, input: {
  userId: number;
  planCode: string;
  durationDays: number;
  grantedBy: number | null;
  note: string | null;
}): Promise<void> {
  const ts = now();
  const expiresAt = input.durationDays > 0 ? ts + input.durationDays * 24 * 60 * 60 * 1000 : null;
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE subscriptions SET status = 'cancelled', updated_at = ? WHERE user_id = ? AND status = 'active'",
    ).bind(ts, input.userId),
    env.DB.prepare(
      `INSERT INTO subscriptions (user_id, plan_code, status, started_at, expires_at, granted_by, note, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(input.userId, input.planCode, ts, expiresAt, input.grantedBy, input.note, ts, ts),
  ]);
}

export async function expireDue(env: Env): Promise<number> {
  const result = await run(
    env,
    "UPDATE subscriptions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < ?",
    now(),
    now(),
  );
  return Number(result.meta?.changes ?? 0);
}

export async function activeCountByPlan(env: Env): Promise<Record<string, number>> {
  const rows = await all<{ plan_code: string; n: number }>(
    env,
    "SELECT plan_code, COUNT(*) AS n FROM subscriptions WHERE status = 'active' GROUP BY plan_code",
  );
  const out: Record<string, number> = {};
  for (const row of rows) out[row.plan_code] = Number(row.n);
  return out;
}
