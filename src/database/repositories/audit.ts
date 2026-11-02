/** Append-only audit log. Never written to by user-supplied field names. */

import type { Env } from "../../config/env";
import { all, run, type Pagination } from "../db";
import { now } from "../../utils/time";
import { sanitize } from "../../utils/logger";

export type ActorType = "telegram_user" | "admin" | "system" | "web";
export type Severity = "debug" | "info" | "warning" | "error" | "critical";

export interface AuditEntry {
  id: number;
  actor_type: ActorType;
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  severity: Severity;
  ip: string | null;
  trace_id: string | null;
  detail: string | null;
  created_at: number;
}

export async function record(env: Env, input: {
  actorType: ActorType;
  actorId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  severity?: Severity;
  ip?: string | null;
  traceId?: string | null;
  detail?: unknown;
}): Promise<void> {
  try {
    const detail = input.detail === undefined ? null : JSON.stringify(sanitize(input.detail)).slice(0, 4000);
    await run(
      env,
      `INSERT INTO audit_logs
         (actor_type, actor_id, action, target_type, target_id, severity, ip, trace_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId === undefined || input.targetId === null ? null : String(input.targetId),
      input.severity ?? "info",
      input.ip ?? null,
      input.traceId ?? null,
      detail,
      now(),
    );
  } catch {
    // Auditing must never break the operation it is recording.
  }
}

export async function list(env: Env, page: Pagination, filters: { action?: string; severity?: string } = {}): Promise<AuditEntry[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.action) {
    clauses.push("action = ?");
    params.push(filters.action);
  }
  if (filters.severity) {
    clauses.push("severity = ?");
    params.push(filters.severity);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(page.limit, page.offset);
  return all<AuditEntry>(env, `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params);
}

export async function recentForUser(env: Env, userId: number, limit = 20): Promise<AuditEntry[]> {
  return all<AuditEntry>(
    env,
    "SELECT * FROM audit_logs WHERE actor_type = 'telegram_user' AND actor_id = ? ORDER BY created_at DESC LIMIT ?",
    userId,
    limit,
  );
}

export async function countSince(env: Env, sinceMs: number, severity?: Severity): Promise<number> {
  if (severity) {
    const rows = await all<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM audit_logs WHERE created_at >= ? AND severity = ?",
      sinceMs,
      severity,
    );
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await all<{ n: number }>(env, "SELECT COUNT(*) AS n FROM audit_logs WHERE created_at >= ?", sinceMs);
  return Number(rows[0]?.n ?? 0);
}

export async function prune(env: Env, retentionDays = 90): Promise<void> {
  await run(env, "DELETE FROM audit_logs WHERE created_at < ?", now() - retentionDays * 24 * 60 * 60 * 1000);
}
