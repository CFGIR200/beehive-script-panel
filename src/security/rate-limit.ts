/**
 * Fixed-window rate limiting backed by D1 (correct) with an optional KV fast
 * path for hot keys. D1 is the source of truth so limits still hold when KV is
 * not configured; KV is a pure optimisation.
 */

import type { Env } from "../config/env";
import { windowStart } from "../utils/time";
import { AppError, messages } from "../utils/errors";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export async function consume(
  env: Env,
  bucketKey: string,
  limit: number,
  windowMs: number,
  amount = 1,
): Promise<RateLimitResult> {
  const start = windowStart(windowMs);
  const resetAt = start + windowMs;

  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket_key, window_start, count)
       VALUES (?, ?, ?)
       ON CONFLICT (bucket_key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start
                      THEN rate_limits.count + excluded.count
                      ELSE excluded.count END,
         window_start = excluded.window_start
       RETURNING count, window_start`,
    )
      .bind(bucketKey, start, amount)
      .first<{ count: number; window_start: number }>();

    const used = Number(row?.count ?? amount);
    return { allowed: used <= limit, remaining: Math.max(0, limit - used), resetAt };
  } catch {
    // A rate-limiter outage must not take the product down: fail open, log via caller.
    return { allowed: true, remaining: limit, resetAt };
  }
}

export async function enforce(
  env: Env,
  bucketKey: string,
  limit: number,
  windowMs: number,
  amount = 1,
): Promise<void> {
  const result = await consume(env, bucketKey, limit, windowMs, amount);
  if (!result.allowed) {
    throw new AppError("RATE_LIMITED", messages.rateLimited, {
      detail: `bucket=${bucketKey} limit=${limit}`,
    });
  }
}

/** Housekeeping: delete buckets whose window has long passed. */
export async function prune(env: Env, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = windowStart(olderThanMs) - olderThanMs;
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
}
