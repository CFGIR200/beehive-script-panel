/**
 * Thin D1 helpers.
 *
 * D1 has no interactive transactions; multi-statement atomic work goes through
 * `batch()` which D1 executes inside a single implicit transaction. Every
 * repository uses parameter binding — no string interpolation of user data.
 */

import type { Env } from "../config/env";

export interface Pagination {
  limit: number;
  offset: number;
}

export function clampPagination(page: number, perPage: number, maxPerPage = 50): Pagination {
  const size = Math.min(Math.max(1, perPage), maxPerPage);
  const index = Math.max(1, Math.floor(page));
  return { limit: size, offset: (index - 1) * size };
}

export function one<T>(env: Env, sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>()
    .then((row) => row ?? null);
}

export async function all<T>(env: Env, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results ?? [];
}

export async function run(env: Env, sql: string, ...params: unknown[]): Promise<D1Result> {
  return env.DB.prepare(sql)
    .bind(...params)
    .run();
}

/** Statement descriptor usable inside batch() — bound values included. */
export interface Statement {
  sql: string;
  params: unknown[];
}

export function stmt(sql: string, ...params: unknown[]): Statement {
  return { sql, params };
}

export async function batch(env: Env, statements: Statement[]): Promise<D1Result[]> {
  if (!statements.length) return [];
  return env.DB.batch(statements.map((s) => env.DB.prepare(s.sql).bind(...s.params)));
}

/** Returns an integer scalar (COUNT(*)) with a default of 0. */
export async function scalar(env: Env, sql: string, ...params: unknown[]): Promise<number> {
  const row = await one<Record<string, unknown>>(env, sql, ...params);
  if (!row) return 0;
  const value = Object.values(row)[0];
  return Number(value ?? 0);
}

export function jsonColumn<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}
