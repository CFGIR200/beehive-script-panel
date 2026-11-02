/**
 * Admin bot handlers (super_admin / admin).
 *
 * Authorisation is enforced here on every entry point with `requireAdmin`, in
 * addition to the router only routing `adm:*` callbacks for staff — defence in
 * depth so a forged callback cannot reach an admin action.
 */

import type { BotContext } from "./context";
import { errorText } from "./context";
import { fa } from "./messages";
import {
  adminGrantPlanKeyboard,
  adminJobsKeyboard,
  adminKeyboard,
  adminPlanKeyboard,
  adminPlansKeyboard,
  adminUserKeyboard,
  adminUsersKeyboard,
  backToMainKeyboard,
  confirmBroadcastKeyboard,
} from "./keyboards";
import * as usersRepo from "../database/repositories/users";
import * as panelsRepo from "../database/repositories/panels";
import * as jobsRepo from "../database/repositories/jobs";
import * as subsRepo from "../database/repositories/subscriptions";
import * as settingsRepo from "../database/repositories/settings";
import * as auditRepo from "../database/repositories/audit";
import { broadcast, countRecipients } from "../admin/broadcast";
import { clampPagination } from "../database/db";
import { formatDateFa, toPersianDigits, DAY } from "../utils/time";
import { AppError, messages } from "../utils/errors";
import { requirePositiveIntFa, sanitizeSearchTerm } from "../security/validation";
import { escape } from "./handlers";

const PAGE_SIZE = 8;

function requireAdmin(ctx: BotContext): void {
  if (!ctx.identity.isAdmin) throw new AppError("FORBIDDEN", fa.adminOnly);
}

export async function adminHome(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const [users, panels, jobs, errors] = await Promise.all([
    usersRepo.count(ctx.env),
    panelsRepo.countAll(ctx.env),
    jobsRepo.activeJobCount(ctx.env),
    auditRepo.countSince(ctx.env, Date.now() - DAY, "error"),
  ]);
  await ctx.edit(fa.adminHome({ users, panels, jobs, errors }), {
    parse_mode: "HTML",
    reply_markup: adminKeyboard(),
  });
}

export async function adminUsers(ctx: BotContext, page = 1): Promise<void> {
  requireAdmin(ctx);
  const users = await usersRepo.list(ctx.env, clampPagination(page, PAGE_SIZE));
  const total = await usersRepo.count(ctx.env);
  const lines = users.map(
    (user) =>
      `${user.is_blocked ? "⛔" : "👤"} <code>${user.telegram_id}</code> — ${escape(user.username ?? user.first_name ?? "—")}`,
  );
  await ctx.edit(
    `👥 <b>کاربران</b> (${toPersianDigits(total)})\n\n${lines.join("\n") || "—"}\n\n` +
      `برای مشاهدهٔ جزئیات، شناسه یا نام کاربری را جست‌وجو کنید.`,
    {
      parse_mode: "HTML",
      reply_markup: adminUsersKeyboard(page, page * PAGE_SIZE < total),
    },
  );
}

export async function adminSearchPrompt(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  await ctx.setState("await_admin_search", {});
  await ctx.edit(fa.adminSearchAsk, { reply_markup: backToMainKeyboard() });
}

export async function handleAdminSearch(ctx: BotContext, term: string): Promise<void> {
  requireAdmin(ctx);
  await ctx.clearState();
  const clean = sanitizeSearchTerm(term);
  const asNumber = Number(clean);
  let user: usersRepo.User | null = null;
  if (Number.isFinite(asNumber) && clean.length >= 5) user = await usersRepo.findByTelegramId(ctx.env, asNumber);
  if (!user) user = await usersRepo.findByUsername(ctx.env, clean);
  if (!user) {
    const rows = await usersRepo.search(ctx.env, clean, { limit: 5, offset: 0 });
    if (rows.length === 1) user = rows[0]!;
    else if (rows.length > 1) {
      await ctx.reply(
        `چند کاربر پیدا شد:\n\n${rows
          .map((row) => `• <code>${row.telegram_id}</code> — ${escape(row.username ?? row.first_name ?? "—")}`)
          .join("\n")}\n\nشناسهٔ دقیق را بفرستید.`,
        { parse_mode: "HTML" },
      );
      return;
    }
  }
  if (!user) {
    await ctx.reply(fa.adminUserNotFound, { reply_markup: adminKeyboard() });
    return;
  }
  await showUserCard(ctx, user);
}

export async function showUserCard(ctx: BotContext, user: usersRepo.User): Promise<void> {
  const [roles, panels, subscription] = await Promise.all([
    usersRepo.rolesOf(ctx.env, user.id),
    panelsRepo.countForUser(ctx.env, user.id),
    subsRepo.activeSubscription(ctx.env, user.id),
  ]);
  await ctx.edit(
    fa.adminUserCard({
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      plan: subscription?.plan_code ?? "—",
      panels,
      blocked: user.is_blocked === 1,
      roles: roles.join(", ") || "user",
      joinedAt: formatDateFa(user.created_at),
    }),
    { parse_mode: "HTML", reply_markup: adminUserKeyboard(user.id, user.is_blocked === 1) },
  );
}

export async function adminUser(ctx: BotContext, userId: number): Promise<void> {
  requireAdmin(ctx);
  const user = await usersRepo.findById(ctx.env, userId);
  if (!user) {
    await ctx.edit(fa.adminUserNotFound, { reply_markup: adminKeyboard() });
    return;
  }
  await showUserCard(ctx, user);
}

export async function adminBlock(ctx: BotContext, userId: number, blocked: boolean): Promise<void> {
  requireAdmin(ctx);
  const user = await usersRepo.findById(ctx.env, userId);
  if (!user) {
    await ctx.answer("کاربر پیدا نشد", true);
    return;
  }
  // A super_admin cannot block another super_admin — that would be a lockout path.
  const targetRoles = await usersRepo.rolesOf(ctx.env, user.id);
  if (targetRoles.includes("super_admin") && !ctx.identity.roles.includes("super_admin")) {
    await ctx.answer("فقط سوپر‌ادمین می‌تواند سوپر‌ادمین را تغییر دهد", true);
    return;
  }
  await usersRepo.setBlocked(ctx.env, user.id, blocked, blocked ? "blocked_by_admin" : null);
  await auditRepo.record(ctx.env, {
    actorType: "admin",
    actorId: ctx.identity.user.id,
    action: blocked ? "user.blocked" : "user.unblocked",
    targetType: "user",
    targetId: user.id,
    severity: blocked ? "warning" : "info",
  });
  await ctx.answer(blocked ? fa.adminBlocked : fa.adminUnblocked);
  await showUserCard(ctx, { ...user, is_blocked: blocked ? 1 : 0 });
}

export async function adminPlanPicker(ctx: BotContext, userId: number): Promise<void> {
  requireAdmin(ctx);
  const plans = await subsRepo.listPlans(ctx.env, false);
  await ctx.edit("پلن موردنظر را انتخاب کنید:", {
    reply_markup: adminGrantPlanKeyboard(
      userId,
      plans.map((plan) => ({ code: plan.code, name: plan.name })),
    ),
  });
}

export async function adminGrantPlan(ctx: BotContext, userId: number, planCode: string): Promise<void> {
  requireAdmin(ctx);
  const [user, plan] = await Promise.all([usersRepo.findById(ctx.env, userId), subsRepo.findPlan(ctx.env, planCode)]);
  if (!user || !plan) {
    await ctx.answer("کاربر یا پلن پیدا نشد", true);
    return;
  }
  await subsRepo.grant(ctx.env, {
    userId: user.id,
    planCode: plan.code,
    durationDays: plan.duration_days,
    grantedBy: ctx.identity.user.id,
    note: "granted_via_bot",
  });
  await auditRepo.record(ctx.env, {
    actorType: "admin",
    actorId: ctx.identity.user.id,
    action: "subscription.granted",
    targetType: "user",
    targetId: user.id,
    detail: { plan: plan.code, durationDays: plan.duration_days },
  });
  await ctx.answer(fa.adminSubGranted(plan.name));
  await showUserCard(ctx, user);
}

export async function adminPlans(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const plans = await subsRepo.listPlans(ctx.env, false);
  const lines = plans.map(
    (plan) =>
      `• <b>${escape(plan.name)}</b> (<code>${escape(plan.code)}</code>)\n` +
      `   سقف پنل: ${plan.max_panels < 0 ? "∞" : toPersianDigits(plan.max_panels)} · ` +
      `قیمت: ${toPersianDigits(plan.price_toman)} تومان · ` +
      `مدت: ${plan.duration_days ? `${toPersianDigits(plan.duration_days)} روز` : "بدون انقضا"}`,
  );
  await ctx.edit(`💳 <b>پلن‌ها</b>\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
    reply_markup: adminPlansKeyboard(plans.map((plan) => ({ code: plan.code, name: plan.name }))),
  });
}

export async function adminPlanDetail(ctx: BotContext, code: string): Promise<void> {
  requireAdmin(ctx);
  const plan = await subsRepo.findPlan(ctx.env, code);
  if (!plan) {
    await ctx.edit("پلن پیدا نشد", { reply_markup: adminKeyboard() });
    return;
  }
  await ctx.edit(
    `💳 <b>${escape(plan.name)}</b>\n\n` +
      `• کد: <code>${escape(plan.code)}</code>\n` +
      `• قیمت: ${toPersianDigits(plan.price_toman)} تومان\n` +
      `• مدت: ${plan.duration_days ? `${toPersianDigits(plan.duration_days)} روز` : "بدون انقضا"}\n` +
      `• سقف پنل: ${plan.max_panels < 0 ? "بدون محدودیت" : toPersianDigits(plan.max_panels)}\n` +
      `• سقف حساب: ${plan.max_accounts < 0 ? "بدون محدودیت" : toPersianDigits(plan.max_accounts)}\n` +
      `• عملیات هم‌زمان: ${toPersianDigits(plan.max_concurrent_jobs)}\n` +
      `• به‌روزرسانی: ${plan.allow_update ? "فعال" : "غیرفعال"} · پشتیبان‌گیری: ${plan.allow_backup ? "فعال" : "غیرفعال"}`,
    { parse_mode: "HTML", reply_markup: adminPlanKeyboard(plan.code) },
  );
}

export async function adminPlanLimitPrompt(ctx: BotContext, code: string): Promise<void> {
  requireAdmin(ctx);
  await ctx.setState("await_plan_limit", { planCode: code });
  await ctx.edit(`سقف تعداد پنل برای پلن <code>${escape(code)}</code> را بفرستید (عدد؛ ‎-1‎ یعنی بدون محدودیت):`, {
    parse_mode: "HTML",
    reply_markup: backToMainKeyboard(),
  });
}

export async function adminPlanPricePrompt(ctx: BotContext, code: string): Promise<void> {
  requireAdmin(ctx);
  await ctx.setState("await_plan_price", { planCode: code });
  await ctx.edit(`قیمت ماهانه پلن <code>${escape(code)}</code> را به تومان بفرستید:`, {
    parse_mode: "HTML",
    reply_markup: backToMainKeyboard(),
  });
}

export async function handlePlanInput(ctx: BotContext, text: string): Promise<boolean> {
  const state = ctx.session?.state;
  if (state !== "await_plan_limit" && state !== "await_plan_price") return false;
  requireAdmin(ctx);
  const code = String(ctx.session?.data.planCode ?? "");
  await ctx.clearState();
  if (!code) {
    await ctx.reply(fa.sessionExpired, { reply_markup: adminKeyboard() });
    return true;
  }
  try {
    if (state === "await_plan_limit") {
      const raw = text.trim();
      const value = raw === "-1" ? -1 : requirePositiveIntFa(raw, "max_panels", { min: 0, max: 1000, allowZero: true });
      await subsRepo.updatePlan(ctx.env, code, { max_panels: value });
      await auditRepo.record(ctx.env, {
        actorType: "admin",
        actorId: ctx.identity.user.id,
        action: "plan.limit_changed",
        targetType: "plan",
        targetId: code,
        detail: { max_panels: value },
      });
      await ctx.reply(`✅ سقف پنل پلن <code>${escape(code)}</code> روی ${value < 0 ? "بدون محدودیت" : toPersianDigits(value)} ثبت شد.`, {
        parse_mode: "HTML",
        reply_markup: adminKeyboard(),
      });
    } else {
      const value = requirePositiveIntFa(text, "price_toman", { min: 0, max: 10_000_000_000, allowZero: true });
      await subsRepo.updatePlan(ctx.env, code, { price_toman: value });
      await auditRepo.record(ctx.env, {
        actorType: "admin",
        actorId: ctx.identity.user.id,
        action: "plan.price_changed",
        targetType: "plan",
        targetId: code,
        detail: { price_toman: value },
      });
      await ctx.reply(`✅ قیمت پلن <code>${escape(code)}</code> روی ${toPersianDigits(value)} تومان ثبت شد.`, {
        parse_mode: "HTML",
        reply_markup: adminKeyboard(),
      });
    }
  } catch (error) {
    await ctx.reply(errorText(error), { reply_markup: adminKeyboard() });
  }
  return true;
}

export async function adminJobs(ctx: BotContext, page = 1): Promise<void> {
  requireAdmin(ctx);
  const jobs = await jobsRepo.listForAdmin(ctx.env, clampPagination(page, PAGE_SIZE));
  const lines = jobs.map(
    (job) =>
      `• <code>${escape(job.id.slice(0, 8))}</code> · ${escape(job.kind)} · ${escape(job.status)} · ` +
      `کاربر ${toPersianDigits(job.user_id)}`,
  );
  await ctx.edit(`🗂 <b>عملیات اخیر</b>\n\n${lines.join("\n") || "—"}`, {
    parse_mode: "HTML",
    reply_markup: adminJobsKeyboard(page, jobs.length === PAGE_SIZE),
  });
}

export async function adminSettings(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const settings = await settingsRepo.all_(ctx.env);
  const installEnabled = settings.install_enabled === "1";
  const maintenance = settings.maintenance_mode === "1";
  await ctx.edit(
    `⚙️ <b>تنظیمات سیستم</b>\n\n` +
      `• نصب پنل: ${installEnabled ? "فعال" : "غیرفعال"}\n` +
      `• حالت تعمیرات: ${maintenance ? "فعال" : "غیرفعال"}\n` +
      `• پلن پیش‌فرض: <code>${escape(settings.default_plan ?? "free")}</code>\n` +
      `• هم‌زمانی سراسری: ${toPersianDigits(Number(settings.max_global_concurrency ?? 6))}`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: installEnabled ? "⏸ غیرفعال‌کردن نصب" : "▶️ فعال‌کردن نصب", callback_data: "adm:toggle_install" }],
          [ { text: maintenance ? "🟢 خروج از تعمیرات" : "🛑 حالت تعمیرات", callback_data: "adm:toggle_maintenance" }],
          [{ text: "🔙 پنل مدیریت", callback_data: "adm:home" }],
        ],
      },
    },
  );
}

export async function adminToggleSetting(ctx: BotContext, key: "install_enabled" | "maintenance_mode"): Promise<void> {
  requireAdmin(ctx);
  const current = await settingsRepo.get(ctx.env, key, "0");
  const next = current === "1" ? "0" : "1";
  await settingsRepo.set(ctx.env, key, next, ctx.identity.user.id);
  await auditRepo.record(ctx.env, {
    actorType: "admin",
    actorId: ctx.identity.user.id,
    action: `settings.${key}.changed`,
    targetType: "system_settings",
    targetId: key,
    severity: "warning",
    detail: { value: next },
  });
  await ctx.answer("ثبت شد");
  await adminSettings(ctx);
}

export async function adminInfra(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const [byStatus, jobsByStatus, plans, subCounts] = await Promise.all([
    panelsRepo.countByStatus(ctx.env),
    jobsRepo.countByStatus(ctx.env),
    subsRepo.listPlans(ctx.env, false),
    subsRepo.activeCountByPlan(ctx.env),
  ]);
  const panelLines = Object.entries(byStatus).map(([status, count]) => `• ${status}: ${toPersianDigits(count)}`);
  const jobLines = Object.entries(jobsByStatus).map(([status, count]) => `• ${status}: ${toPersianDigits(count)}`);
  const planLines = plans.map(
    (plan) => `• ${plan.name}: ${toPersianDigits(subCounts[plan.code] ?? 0)} اشتراک فعال`,
  );
  await ctx.edit(
    `🩺 <b>وضعیت زیرساخت</b>\n\n<b>پنل‌ها</b>\n${panelLines.join("\n") || "—"}\n\n` +
      `<b>عملیات</b>\n${jobLines.join("\n") || "—"}\n\n<b>اشتراک‌ها</b>\n${planLines.join("\n") || "—"}`,
    { parse_mode: "HTML", reply_markup: backToAdmin() },
  );
}

function backToAdmin() {
  return { inline_keyboard: [[{ text: "🔙 پنل مدیریت", callback_data: "adm:home" }]] };
}

export async function adminBroadcastPrompt(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const paused = await settingsRepo.getBool(ctx.env, "broadcast_paused", false);
  if (paused) {
    await ctx.edit("📣 ارسال همگانی در حال حاضر متوقف است.", { reply_markup: adminKeyboard() });
    return;
  }
  await ctx.setState("await_broadcast_text", {});
  await ctx.edit(fa.broadcastAsk, { reply_markup: backToMainKeyboard() });
}

export async function handleBroadcastText(ctx: BotContext, text: string): Promise<void> {
  requireAdmin(ctx);
  const body = text.trim().slice(0, 3800);
  if (body.length < 3) {
    await ctx.reply("متن پیام خیلی کوتاه است.", { reply_markup: adminKeyboard() });
    return;
  }
  await ctx.setState("await_broadcast_text", { body, stage: "confirm" });
  const recipients = await countRecipients(ctx.env);
  await ctx.reply(fa.broadcastConfirm(recipients, body), {
    parse_mode: "HTML",
    reply_markup: confirmBroadcastKeyboard(),
  });
}

export async function confirmBroadcast(ctx: BotContext): Promise<void> {
  requireAdmin(ctx);
  const body = String(ctx.session?.data.body ?? "");
  const stage = String(ctx.session?.data.stage ?? "");
  if (!body || stage !== "confirm") {
    await ctx.answer("پیامی برای ارسال نیست", true);
    return;
  }
  await ctx.clearState();
  await ctx.answer("ارسال آغاز شد");
  const result = await broadcast(ctx.env, {
    text: body,
    adminUserId: ctx.identity.user.id,
    telegram: ctx.telegram,
    chunkSize: 25,
  });
  await ctx.reply(fa.broadcastDone(result.sent, result.failed), { reply_markup: adminKeyboard() });
}

export { messages, panelsRepo };
