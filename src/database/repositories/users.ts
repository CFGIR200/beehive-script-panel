/** Users, roles and admin sessions. */

import type { Env } from "../../config/env";
import { all, batch, one, run, scalar, stmt, type Pagination } from "../db";
import { now } from "../../utils/time";
import { AppError, messages } from "../../utils/errors";

export type Role = "super_admin" | "admin" | "support" | "user";

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  is_blocked: number;
  blocked_reason: string | null;
  created_at: number;
  last_seen_at: number;
  notes: string | null;
}

export interface TelegramProfile {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

export interface UserWithRoles extends User {
  roles: Role[];
}

const ROLE_PRECEDENCE: Role[] = ["super_admin", "admin", "support", "user"];

export function isStaff(roles: Role[]): boolean {
  return roles.some((role) => role === "super_admin" || role === "admin" || role === "support");
}

export function isAdmin(roles: Role[]): boolean {
  return roles.some((role) => role === "super_admin" || role === "admin");
}

export function highestRole(roles: Role[]): Role {
  for (const role of ROLE_PRECEDENCE) if (roles.includes(role)) return role;
  return "user";
}

export async function upsertFromTelegram(env: Env, profile: TelegramProfile): Promise<User> {
  const ts = now();
  await run(
    env,
    `INSERT INTO users (telegram_id, username, first_name, last_name, language_code, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       language_code = excluded.language_code,
       last_seen_at = excluded.last_seen_at`,
    profile.id,
    profile.username ?? null,
    profile.first_name ?? null,
    profile.last_name ?? null,
    profile.language_code ?? null,
    ts,
    ts,
  );
  const user = await one<User>(env, "SELECT * FROM users WHERE telegram_id = ?", profile.id);
  if (!user) throw new AppError("INTERNAL", messages.internal, { detail: "user upsert returned no row" });
  return user;
}

export async function findByTelegramId(env: Env, telegramId: number): Promise<User | null> {
  return one<User>(env, "SELECT * FROM users WHERE telegram_id = ?", telegramId);
}

export async function findById(env: Env, id: number): Promise<User | null> {
  return one<User>(env, "SELECT * FROM users WHERE id = ?", id);
}

export async function findByUsername(env: Env, username: string): Promise<User | null> {
  const clean = username.replace(/^@/, "").trim();
  if (!clean) return null;
  return one<User>(env, "SELECT * FROM users WHERE username = ? COLLATE NOCASE", clean);
}

export async function count(env: Env, options: { blocked?: boolean } = {}): Promise<number> {
  if (options.blocked === true) return scalar(env, "SELECT COUNT(*) FROM users WHERE is_blocked = 1");
  if (options.blocked === false) return scalar(env, "SELECT COUNT(*) FROM users WHERE is_blocked = 0");
  return scalar(env, "SELECT COUNT(*) FROM users");
}

export async function list(env: Env, page: Pagination): Promise<User[]> {
  return all<User>(env, "SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?", page.limit, page.offset);
}

export async function search(env: Env, term: string, page: Pagination): Promise<User[]> {
  const like = `%${term}%`;
  return all<User>(
    env,
    `SELECT * FROM users
     WHERE username LIKE ? COLLATE NOCASE
        OR first_name LIKE ? COLLATE NOCASE
        OR CAST(telegram_id AS TEXT) LIKE ?
     ORDER BY last_seen_at DESC
     LIMIT ? OFFSET ?`,
    like,
    like,
    like,
    page.limit,
    page.offset,
  );
}

export async function setBlocked(env: Env, userId: number, blocked: boolean, reason: string | null): Promise<void> {
  await run(env, "UPDATE users SET is_blocked = ?, blocked_reason = ? WHERE id = ?", blocked ? 1 : 0, reason, userId);
}

export async function setNotes(env: Env, userId: number, notes: string | null): Promise<void> {
  await run(env, "UPDATE users SET notes = ? WHERE id = ?", notes, userId);
}

export async function touch(env: Env, userId: number): Promise<void> {
  await run(env, "UPDATE users SET last_seen_at = ? WHERE id = ?", now(), userId);
}

export async function rolesOf(env: Env, userId: number): Promise<Role[]> {
  const rows = await all<{ role: Role }>(env, "SELECT role FROM user_roles WHERE user_id = ?", userId);
  return rows.map((row) => row.role);
}

export async function rolesByTelegramId(env: Env, telegramId: number): Promise<Role[]> {
  const rows = await all<{ role: Role }>(
    env,
    `SELECT r.role FROM user_roles r JOIN users u ON u.id = r.user_id WHERE u.telegram_id = ?`,
    telegramId,
  );
  return rows.map((row) => row.role);
}

export async function grantRole(env: Env, userId: number, role: Role, grantedBy: number | null): Promise<void> {
  await run(
    env,
    `INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, role) DO NOTHING`,
    userId,
    role,
    grantedBy,
    now(),
  );
}

export async function revokeRole(env: Env, userId: number, role: Role): Promise<void> {
  await run(env, "DELETE FROM user_roles WHERE user_id = ? AND role = ?", userId, role);
}

export async function countSuperAdmins(env: Env): Promise<number> {
  return scalar(env, "SELECT COUNT(*) FROM user_roles WHERE role = 'super_admin'");
}

export async function ensureBootstrapAdmin(env: Env, telegramId: number | null): Promise<boolean> {
  if (!telegramId) return false;
  const admins = await countSuperAdmins(env);
  if (admins > 0) return false;
  const user = await findByTelegramId(env, telegramId);
  if (!user) return false;
  await batch(env, [
    stmt(
      `INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'super_admin', NULL, ?)
       ON CONFLICT (user_id, role) DO NOTHING`,
      user.id,
      now(),
    ),
    stmt(`INSERT INTO user_roles (user_id, role, granted_by, granted_at) VALUES (?, 'user', NULL, ?)
          ON CONFLICT (user_id, role) DO NOTHING`, user.id, now()),
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Admin (web dashboard) sessions
// ---------------------------------------------------------------------------

export interface AdminSession {
  id: string;
  user_id: number;
  role: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
}

export async function createAdminSession(env: Env, input: {
  id: string;
  userId: number;
  role: string;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const ts = now();
  await run(
    env,
    `INSERT INTO admin_sessions (id, user_id, role, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.userId,
    input.role,
    ts,
    input.expiresAt,
    ts,
    input.ip,
    input.userAgent,
  );
}

export async function findAdminSession(env: Env, id: string): Promise<AdminSession | null> {
  const session = await one<AdminSession>(env, "SELECT * FROM admin_sessions WHERE id = ?", id);
  if (!session) return null;
  if (session.expires_at < now()) {
    await deleteAdminSession(env, id);
    return null;
  }
  await run(env, "UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?", now(), id);
  return session;
}

export async function deleteAdminSession(env: Env, id: string): Promise<void> {
  await run(env, "DELETE FROM admin_sessions WHERE id = ?", id);
}

export async function pruneAdminSessions(env: Env): Promise<void> {
  await run(env, "DELETE FROM admin_sessions WHERE expires_at < ?", now());
}
