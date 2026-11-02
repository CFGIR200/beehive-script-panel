/**
 * Dashboard authentication.
 *
 * Login is a two-step Telegram proof-of-possession:
 *   1. the operator types their Telegram user id,
 *   2. the bot sends a 6-digit one-time code to that Telegram account,
 *   3. entering the code creates a server-side session.
 *
 * Sessions live in D1 (`admin_sessions`) and the cookie carries
 * `<sessionId>.<hmac>` so a tampered id is rejected before any database read.
 * Only staff roles (super_admin / admin / support) may sign in.
 */

import type { Env, PublicConfig } from "../config/env";
import { ADMIN_SESSION_TTL_MS } from "../config/constants";
import { hmacSha256Hex } from "../security/crypto";
import { constantTimeEqual, randomToken, sha256Hex } from "../utils/ids";
import * as usersRepo from "../database/repositories/users";
import * as pendingRepo from "../database/repositories/pending";
import { TelegramClient } from "../bot/telegram";
import { AppError, messages } from "../utils/errors";

export const DASHBOARD_COOKIE = "bh_admin";

export interface DashboardIdentity {
  sessionId: string;
  user: usersRepo.User;
  roles: usersRepo.Role[];
  isAdmin: boolean;
}

/** Step 1: create the code and deliver it through Telegram. */
export async function requestLoginCode(
  env: Env,
  config: PublicConfig,
  telegramId: number,
): Promise<{ delivered: boolean; handle: string | null }> {
  void config;
  const user = await usersRepo.findByTelegramId(env, telegramId);
  // Same response whether or not the user exists — no account enumeration.
  if (!user) return { delivered: false, handle: null };

  const roles = await usersRepo.rolesOf(env, user.id);
  if (!usersRepo.isStaff(roles)) return { delivered: false, handle: null };

  const { handle, code } = await pendingRepo.createLoginCode(env, user.id);
  const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  try {
    await telegram.sendMessage(
      user.telegram_id,
      `🔐 <b>کد ورود به داشبورد</b>\n\n<code>${code}</code>\n\nاین کد ۵ دقیقه اعتبار دارد. اگر شما درخواست نداده‌اید، نادیده بگیرید.`,
      { parse_mode: "HTML" },
    );
    return { delivered: true, handle };
  } catch {
    return { delivered: false, handle: null };
  }
}

/** Step 2: verify the code and create the session. */
export async function verifyLoginCode(
  env: Env,
  handle: string,
  code: string,
  meta: { ip: string; userAgent: string | null },
): Promise<DashboardIdentity | null> {
  const userId = await pendingRepo.verifyLoginCode(env, handle, code);
  if (!userId) return null;

  const user = await usersRepo.findById(env, userId);
  if (!user || user.is_blocked) return null;
  const roles = await usersRepo.rolesOf(env, user.id);
  if (!usersRepo.isStaff(roles)) return null;

  const sessionId = randomToken(32);
  await usersRepo.createAdminSession(env, {
    id: sessionId,
    userId: user.id,
    role: usersRepo.highestRole(roles),
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return { sessionId, user, roles, isAdmin: usersRepo.isAdmin(roles) };
}

export async function buildCookie(env: Env, sessionId: string): Promise<string> {
  const signature = await sign(env, sessionId);
  return `${DASHBOARD_COOKIE}=${sessionId}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
    ADMIN_SESSION_TTL_MS / 1000,
  )}`;
}

export const clearCookie = (): string =>
  `${DASHBOARD_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function sign(env: Env, sessionId: string): Promise<string> {
  return hmacSha256Hex(env.SESSION_SIGNING_KEY, `dash:${sessionId}`);
}

function readCookie(request: Request): string | null {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${DASHBOARD_COOKIE}=`)) return trimmed.slice(DASHBOARD_COOKIE.length + 1);
  }
  return null;
}

export async function authenticateDashboard(env: Env, request: Request): Promise<DashboardIdentity | null> {
  const raw = readCookie(request);
  if (!raw) return null;
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const sessionId = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!/^[a-z0-9]{20,64}$/.test(sessionId)) return null;

  const expected = await sign(env, sessionId);
  if (!constantTimeEqual(expected, signature)) return null;

  const session = await usersRepo.findAdminSession(env, sessionId);
  if (!session) return null;

  const user = await usersRepo.findById(env, session.user_id);
  if (!user || user.is_blocked) return null;
  const roles = await usersRepo.rolesOf(env, user.id);
  if (!usersRepo.isStaff(roles)) return null;

  return { sessionId, user, roles, isAdmin: usersRepo.isAdmin(roles) };
}

export async function requireDashboard(env: Env, request: Request): Promise<DashboardIdentity> {
  const identity = await authenticateDashboard(env, request);
  if (!identity) throw new AppError("UNAUTHORIZED", messages.unauthorized);
  return identity;
}

export async function logout(env: Env, sessionId: string): Promise<void> {
  await usersRepo.deleteAdminSession(env, sessionId);
}

export async function hashCodeForLog(code: string): Promise<string> {
  return (await sha256Hex(code)).slice(0, 8);
}
