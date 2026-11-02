/**
 * Admin web dashboard (server-rendered).
 *
 * Pages: overview · users · panels · jobs · plans · audit · settings
 * Actions are POST-only, CSRF-protected (double-submit token bound to the
 * session) and every mutation is written to the audit log.
 */

import type { Env, PublicConfig } from "../config/env";
import { layout, notice, pill, stat } from "./layout";
import { authenticateDashboard, buildCookie, clearCookie, requestLoginCode, verifyLoginCode, logout } from "../auth/dashboard";
import { escapeHtml, html, redirect, clientIp, json } from "../utils/http";
import * as usersRepo from "../database/repositories/users";
import * as panelsRepo from "../database/repositories/panels";
import * as jobsRepo from "../database/repositories/jobs";
import * as subsRepo from "../database/repositories/subscriptions";
import * as auditRepo from "../database/repositories/audit";
import * as settingsRepo from "../database/repositories/settings";
import * as accountsRepo from "../database/repositories/accounts";
import * as engines from "../provisioning/engine";
import * as manager from "../panels/manager";
import { clampPagination } from "../database/db";
import { formatDateFa, formatRelativeFa, toPersianDigits, DAY } from "../utils/time";
import { hmacSha256Hex } from "../security/crypto";
import { AppError, messages } from "../utils/errors";
import { PRODUCT_VERSION, HARD_LIMITS } from "../config/constants";
import { sanitizeSearchTerm } from "../security/validation";

const TABS = (active: string) => [
  { href: "/dashboard?page=overview", label: "نمای کلی", active: active === "overview" },
  { href: "/dashboard?page=users", label: "کاربران", active: active === "users" },
  { href: "/dashboard?page=panels", label: "پنل‌ها", active: active === "panels" },
  { href: "/dashboard?page=jobs", label: "عملیات", active: active === "jobs" },
  { href: "/dashboard?page=plans", label: "پلن‌ها", active: active === "plans" },
  { href: "/dashboard?page=audit", label: "گزارش رویدادها", active: active === "audit" },
  { href: "/dashboard?page=settings", label: "تنظیمات", active: active === "settings" },
];

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export function loginPage(error?: string, info?: string): string {
  const body = `
<div class="card">
  <h1>🔐 ورود به داشبورد مدیریت</h1>
  <p>داشبورد فقط برای نقش‌های مدیریتی است. برای ورود، ابتدا شناسهٔ عددی تلگرام خود را وارد کنید تا
     کد یک‌بارمصرف به حساب تلگرام شما ارسال شود.</p>
  ${error ? notice("error", error) : ""}
  ${info ? notice("ok", info) : ""}
  <form method="POST" action="/dashboard/login">
    <label for="telegram_id">شناسهٔ عددی تلگرام</label>
    <input id="telegram_id" name="telegram_id" inputmode="numeric" autocomplete="off" required>
    <button class="btn" type="submit">ارسال کد ورود</button>
  </form>
</div>`;
  return layout({ title: "ورود", body });
}

export async function handleLoginPost(env: Env, config: PublicConfig, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const telegramId = Number(form ? String(form.get("telegram_id") ?? "") : "");
  if (!Number.isFinite(telegramId) || telegramId <= 0) {
    return html(loginPage("شناسهٔ تلگرام معتبر نیست."), 400);
  }
  const result = await requestLoginCode(env, config, telegramId);
  if (!result.delivered || !result.handle) {
    // Uniform response — do not disclose whether the id belongs to staff.
    return html(loginPage(undefined, "اگر این شناسه متعلق به یک مدیر باشد، کد ورود برای شما ارسال شد."), 200);
  }
  return html(codeEntryPage(result.handle));
}

export async function handleVerifyPost(env: Env, request: Request): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const handle = form ? String(form.get("handle") ?? "") : "";
  const code = form ? String(form.get("code") ?? "").replace(/[^0-9]/g, "") : "";

  if (!handle || code.length !== 6) {
    return html(loginPage("نشست ورود معتبر نیست؛ لطفاً از ابتدا تلاش کنید."), 400);
  }

  const identity = await verifyLoginCode(env, handle, code, {
    ip: clientIp(request),
    userAgent: request.headers.get("User-Agent"),
  });
  if (!identity) return html(codeEntryPage(handle, "کد نامعتبر یا منقضی است."), 401);

  await auditRepo.record(env, {
    actorType: "admin",
    actorId: identity.user.id,
    action: "dashboard.login",
    ip: clientIp(request),
    severity: "info",
  });
  const cookie = await buildCookie(env, identity.sessionId);
  return new Response(null, { status: 303, headers: { Location: "/dashboard", "Set-Cookie": cookie } });
}

/** Renders the login flow page that pairs the id and code (single form). */
export function codeEntryPage(handle: string, error?: string): string {
  const body = `
<div class="card">
  <h1>📩 کد ورود</h1>
  <p>کدی که ربات برای شما ارسال کرد را وارد کنید. این کد ۵ دقیقه اعتبار دارد.</p>
  ${error ? notice("error", error) : ""}
  <form method="POST" action="/dashboard/verify">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <label for="code">کد یک‌بارمصرف</label>
    <input id="code" name="code" inputmode="numeric" maxlength="6" required autocomplete="one-time-code">
    <button class="btn" type="submit">ورود</button>
  </form>
</div>`;
  return layout({ title: "کد ورود", body });
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

export async function csrfToken(env: Env, sessionId: string): Promise<string> {
  return (await hmacSha256Hex(env.SESSION_SIGNING_KEY, `csrf:${sessionId}`)).slice(0, 32);
}

async function assertCsrf(env: Env, sessionId: string, form: FormData | null): Promise<void> {
  const provided = form ? String(form.get("csrf") ?? "") : "";
  if (!provided) throw new AppError("FORBIDDEN", "نشست معتبر نیست؛ صفحه را دوباره بارگذاری کنید.");
  const expected = await csrfToken(env, sessionId);
  if (provided !== expected) {
    throw new AppError("FORBIDDEN", "توکن امنیتی نامعتبر است؛ صفحه را دوباره بارگذاری کنید.");
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export async function renderDashboard(
  env: Env,
  config: PublicConfig,
  request: Request,
  url: URL,
): Promise<Response> {
  const identity = await authenticateDashboard(env, request);
  if (!identity) return redirect("/dashboard/login");

  const page = url.searchParams.get("page") ?? "overview";
  const csrf = await csrfToken(env, identity.sessionId);
  const tabs = TABS(page);

  const render = (title: string, body: string) =>
    html(
      layout({
        title,
        tabs,
        body: `
<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
  <div>
    <h1 style="margin:0">${escapeHtml(title)}</h1>
    <p class="small" style="margin:4px 0 0">${escapeHtml(identity.user.first_name ?? "")}
      · نقش: ${escapeHtml(usersRepo.highestRole(identity.roles))} · نسخهٔ ${PRODUCT_VERSION}</p>
  </div>
  <form method="POST" action="/dashboard/logout">
    <input type="hidden" name="csrf" value="${csrf}">
    <button class="btn secondary" style="width:auto;margin:0" type="submit">خروج</button>
  </form>
</div>
${body}`,
        footerNote: config.publicBaseUrl,
      }),
    );

  switch (page) {
    case "users":
      return render("کاربران", await usersPage(env, url, csrf));
    case "panels":
      return render("پنل‌ها", await panelsPage(env, url, csrf));
    case "jobs":
      return render("عملیات", await jobsPage(env, url, csrf));
    case "plans":
      return render("پلن‌ها", await plansPage(env, csrf));
    case "audit":
      return render("گزارش رویدادها", await auditPage(env, url));
    case "settings":
      return render("تنظیمات", await settingsPage(env, csrf));
    default:
      return render("نمای کلی", await overviewPage(env));
  }
}

async function overviewPage(env: Env): Promise<string> {
  const [users, blocked, panels, panelStatus, jobs, jobStatus, errorCount, subs] = await Promise.all([
    usersRepo.count(env),
    usersRepo.count(env, { blocked: true }),
    panelsRepo.countAll(env),
    panelsRepo.countByStatus(env),
    jobsRepo.activeJobCount(env),
    jobsRepo.countByStatus(env),
    auditRepo.countSince(env, Date.now() - DAY, "error"),
    subsRepo.activeCountByPlan(env),
  ]);

  const recentJobs = await jobsRepo.listForAdmin(env, { limit: 8, offset: 0 });
  const jobRows = recentJobs
    .map(
      (job) => `<tr>
      <td class="mono">${escapeHtml(job.id.slice(0, 8))}</td>
      <td>${escapeHtml(job.kind)}</td>
      <td>${jobPill(job.status)}</td>
      <td>${toPersianDigits(job.steps_done)}/${toPersianDigits(job.steps_total)}</td>
      <td>${escapeHtml(formatRelativeFa(job.created_at))}</td>
      <td>${job.error_message ? escapeHtml(job.error_message.slice(0, 60)) : "—"}</td>
    </tr>`,
    )
    .join("");

  return `
<div class="card">
  <h2>آمار کلی</h2>
  <div class="grid">
    ${stat("کاربران", users)}
    ${stat("مسدود", blocked)}
    ${stat("پنل‌ها", panels)}
    ${stat("عملیات فعال", jobs)}
    ${stat("خطا (۲۴ ساعت)", errorCount)}
  </div>
</div>
<div class="card">
  <h2>وضعیت پنل‌ها</h2>
  <div class="grid">
    ${Object.entries(panelStatus)
      .map(([status, count]) => stat(status, count))
      .join("") || "<p>—</p>"}
  </div>
</div>
<div class="card">
  <h2>وضعیت عملیات</h2>
  <div class="grid">${Object.entries(jobStatus).map(([status, count]) => stat(status, count)).join("") || "—"}</div>
</div>
<div class="card">
  <h2>اشتراک‌های فعال</h2>
  <div class="grid">${Object.entries(subs).map(([plan, count]) => stat(plan, count)).join("") || "—"}</div>
</div>
<div class="card">
  <h2>آخرین عملیات</h2>
  <table><thead><tr><th>شناسه</th><th>نوع</th><th>وضعیت</th><th>پیشرفت</th><th>زمان</th><th>خطا</th></tr></thead>
  <tbody>${jobRows || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
</div>`;
}

async function usersPage(env: Env, url: URL, csrf: string): Promise<string> {
  const page = Number(url.searchParams.get("p") ?? "1");
  const term = sanitizeSearchTerm(url.searchParams.get("q") ?? "");
  const rows = term
    ? await usersRepo.search(env, term, clampPagination(page, 25))
    : await usersRepo.list(env, clampPagination(page, 25));

  const table = rows
    .map(
      (user) => `<tr>
      <td class="mono">${user.telegram_id}</td>
      <td>${escapeHtml(user.username ?? "—")}</td>
      <td>${escapeHtml(user.first_name ?? "—")}</td>
      <td>${user.is_blocked ? pill("مسدود", "bad") : pill("فعال", "ok")}</td>
      <td>${escapeHtml(formatRelativeFa(user.last_seen_at))}</td>
      <td>
        <form method="POST" action="/dashboard/action" style="display:inline">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="action" value="${user.is_blocked ? "unblock_user" : "block_user"}">
          <input type="hidden" name="userId" value="${user.id}">
          <button class="btn secondary" style="width:auto;margin:0;padding:6px 10px" type="submit">
            ${user.is_blocked ? "رفع مسدودی" : "مسدودسازی"}
          </button>
        </form>
      </td>
    </tr>`,
    )
    .join("");

  return `
<div class="card">
  <form method="GET" action="/dashboard" class="row">
    <input type="hidden" name="page" value="users">
    <input name="q" placeholder="جست‌وجو: شناسه، نام کاربری یا نام" value="${escapeHtml(term)}">
    <button class="btn secondary" style="margin:0" type="submit">جست‌وجو</button>
  </form>
</div>
<div class="card">
  <table><thead><tr><th>تلگرام</th><th>نام کاربری</th><th>نام</th><th>وضعیت</th><th>آخرین بازدید</th><th>عملیات</th></tr></thead>
  <tbody>${table || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
  <div class="row" style="margin-top:14px">
    ${page > 1 ? `<a class="btn secondary" style="text-align:center;text-decoration:none" href="/dashboard?page=users&p=${page - 1}${term ? `&q=${encodeURIComponent(term)}` : ""}">صفحهٔ قبل</a>` : ""}
    ${rows.length === 25 ? `<a class="btn secondary" style="text-align:center;text-decoration:none" href="/dashboard?page=users&p=${page + 1}${term ? `&q=${encodeURIComponent(term)}` : ""}">صفحهٔ بعد</a>` : ""}
  </div>
</div>`;
}

async function panelsPage(env: Env, url: URL, csrf: string): Promise<string> {
  const pages = clampPagination(Number(url.searchParams.get("p") ?? "1"), 25);
  const panels = await panelsRepo.listAll(env, pages);
  const rows = await Promise.all(
    panels.map(async (panel) => {
      const account = await accountsRepo.findForUser(env, panel.user_id, panel.account_ref);
      return `<tr>
      <td class="mono">${escapeHtml(panel.worker_name)}</td>
      <td>${toPersianDigits(panel.user_id)}</td>
      <td>${escapeHtml(account?.account_name ?? "—")}</td>
      <td>${panel.status}</td>
      <td class="mono">${escapeHtml(panel.version ?? "—")}</td>
      <td>${escapeHtml(panel.last_health_status ?? "—")}</td>
      <td>${escapeHtml(formatRelativeFa(panel.updated_at))}</td>
      <td>${panel.panel_url ? `<a href="${escapeHtml(panel.panel_url)}" target="_blank" rel="noreferrer noopener">باز کردن</a>` : "—"}</td>
      <td>
        ${
          panel.deleted_at
            ? "—"
            : `<form method="POST" action="/dashboard/action" style="display:inline">
                 <input type="hidden" name="csrf" value="${csrf}">
                 <input type="hidden" name="action" value="health_check">
                 <input type="hidden" name="panelId" value="${panel.id}">
                 <button class="btn secondary" style="width:auto;margin:0;padding:6px 10px" type="submit">بررسی سلامت</button>
               </form>`
        }
      </td>
    </tr>`;
    }),
  );
  return `
<div class="card">
  <table><thead><tr><th>Worker</th><th>کاربر</th><th>حساب</th><th>وضعیت</th><th>نسخه</th><th>سلامت</th><th>آخرین تغییر</th><th>آدرس</th><th></th></tr></thead>
  <tbody>${rows.join("") || '<tr><td colspan="9">—</td></tr>'}</tbody></table>
</div>`;
}

async function jobsPage(env: Env, url: URL, csrf: string): Promise<string> {
  const pages = clampPagination(Number(url.searchParams.get("p") ?? "1"), 25);
  const status = url.searchParams.get("status") ?? undefined;
  const jobs = await jobsRepo.listForAdmin(env, pages, status ?? undefined);
  const rows = jobs
    .map(
      (job) => `<tr>
      <td class="mono">${escapeHtml(job.id.slice(0, 8))}</td>
      <td>${escapeHtml(job.kind)}</td>
      <td>${jobPill(job.status)}</td>
      <td>${toPersianDigits(job.steps_done)}/${toPersianDigits(job.steps_total)}</td>
      <td>${toPersianDigits(job.user_id)}</td>
      <td class="mono">${escapeHtml(job.trace_id)}</td>
      <td>${escapeHtml(job.error_message ? job.error_message.slice(0, 60) : "—")}</td>
      <td>${
        jobsRepo.isTerminal(job.status)
          ? "—"
          : `<form method="POST" action="/dashboard/action" style="display:inline">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="action" value="cancel_job">
              <input type="hidden" name="jobId" value="${escapeHtml(job.id)}">
              <button class="btn danger" style="width:auto;margin:0;padding:6px 10px" type="submit">لغو</button>
            </form>`
      }</td>
    </tr>`,
    )
    .join("");
  return `
<div class="card">
  <form method="GET" action="/dashboard" class="row">
    <input type="hidden" name="page" value="jobs">
    <select name="status">
      <option value="">همهٔ وضعیت‌ها</option>
      ${["pending", "validating", "provisioning", "configuring", "deploying", "verifying", "completed", "failed", "cancelled", "rolled_back"]
        .map((option) => `<option value="${option}" ${status === option ? "selected" : ""}>${option}</option>`)
        .join("")}
    </select>
    <button class="btn secondary" style="margin:0" type="submit">فیلتر</button>
  </form>
</div>
<div class="card">
  <table><thead><tr><th>شناسه</th><th>نوع</th><th>وضعیت</th><th>پیشرفت</th><th>کاربر</th><th>رهگیری</th><th>خطا</th><th></th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8">—</td></tr>'}</tbody></table>
</div>`;
}

async function plansPage(env: Env, csrf: string): Promise<string> {
  const plans = await subsRepo.listPlans(env, false);
  const cards = plans
    .map(
      (plan) => `<div class="card">
      <h3>${escapeHtml(plan.name)} · <span class="mono">${escapeHtml(plan.code)}</span></h3>
      <form method="POST" action="/dashboard/action">
        <input type="hidden" name="csrf" value="${csrf}">
        <input type="hidden" name="action" value="update_plan">
        <input type="hidden" name="planCode" value="${escapeHtml(plan.code)}">
        <div class="row">
          <div><label>قیمت (تومان)</label><input name="priceToman" inputmode="numeric" value="${plan.price_toman}"></div>
          <div><label>سقف پنل (−1 = ∞)</label><input name="maxPanels" inputmode="numeric" value="${plan.max_panels}"></div>
          <div><label>سقف حساب</label><input name="maxAccounts" inputmode="numeric" value="${plan.max_accounts}"></div>
          <div><label>مدت (روز، ۰ = بدون انقضا)</label><input name="durationDays" inputmode="numeric" value="${plan.duration_days}"></div>
        </div>
        <div class="row" style="margin-top:10px">
          <label><input type="checkbox" name="allowUpdate" ${plan.allow_update ? "checked" : ""} style="width:auto"> به‌روزرسانی</label>
          <label><input type="checkbox" name="allowBackup" ${plan.allow_backup ? "checked" : ""} style="width:auto"> پشتیبان‌گیری</label>
          <label><input type="checkbox" name="isActive" ${plan.is_active ? "checked" : ""} style="width:auto"> فعال</label>
        </div>
        <button class="btn" type="submit">ذخیرهٔ پلن</button>
      </form>
    </div>`,
    )
    .join("");
  return `<div class="list">${cards}</div>`;
}

async function auditPage(env: Env, url: URL): Promise<string> {
  const pages = clampPagination(Number(url.searchParams.get("p") ?? "1"), 40);
  const severity = url.searchParams.get("severity") ?? undefined;
  const logs = await auditRepo.list(env, pages, severity ? { severity } : {});
  const rows = logs
    .map(
      (entry) => `<tr>
      <td>${escapeHtml(formatDateFa(entry.created_at))}</td>
      <td>${escapeHtml(entry.actor_type)}${entry.actor_id ? `:${toPersianDigits(entry.actor_id)}` : ""}</td>
      <td class="mono">${escapeHtml(entry.action)}</td>
      <td>${severityPill(entry.severity)}</td>
      <td class="mono">${escapeHtml(entry.target_id ?? "—")}</td>
      <td class="small">${escapeHtml((entry.detail ?? "").slice(0, 120))}</td>
    </tr>`,
    )
    .join("");
  return `
<div class="card">
  <form method="GET" action="/dashboard" class="row">
    <input type="hidden" name="page" value="audit">
    <select name="severity">
      <option value="">همه</option>
      ${["debug", "info", "warning", "error", "critical"]
        .map((option) => `<option value="${option}" ${severity === option ? "selected" : ""}>${option}</option>`)
        .join("")}
    </select>
    <button class="btn secondary" style="margin:0" type="submit">فیلتر</button>
  </form>
</div>
<div class="card">
  <table><thead><tr><th>زمان</th><th>عامل</th><th>رویداد</th><th>سطح</th><th>هدف</th><th>جزئیات</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">—</td></tr>'}</tbody></table>
</div>`;
}

async function settingsPage(env: Env, csrf: string): Promise<string> {
  const settings = await settingsRepo.all_(env);
  const hidden = new Set(["panel_password"]);
  const rows = Object.entries(settings)
    .filter(([key]) => !hidden.has(key))
    .map(
      ([key, value]) => `<tr>
      <td class="mono">${escapeHtml(key)}</td>
      <td>
        <form method="POST" action="/dashboard/action" style="display:flex;gap:8px">
          <input type="hidden" name="csrf" value="${csrf}">
          <input type="hidden" name="action" value="set_setting">
          <input type="hidden" name="key" value="${escapeHtml(key)}">
          <input name="value" value="${escapeHtml(value ?? "")}">
          <button class="btn secondary" style="width:auto;margin:0;padding:6px 10px" type="submit">ذخیره</button>
        </form>
      </td>
    </tr>`,
    )
    .join("");
  return `
<div class="card">
  <h2>تنظیمات سیستم</h2>
  <p class="small">مقادیر حساس (مانند کلید رمزنگاری) در این جدول نیستند و هرگز در داشبورد نمایش داده نمی‌شوند.</p>
  <table><tbody>${rows}</tbody></table>
</div>
<div class="card">
  <h2>محدودیت‌های سخت</h2>
  <div class="grid">
    ${stat("حداکثر پنل هر کاربر", HARD_LIMITS.maxPanelsPerUser)}
    ${stat("حداکثر حساب هر کاربر", HARD_LIMITS.maxAccountsPerUser)}
  </div>
</div>`;
}

function jobPill(status: string): string {
  if (status === "completed") return pill(status, "ok");
  if (status === "failed" || status === "rollback_required") return pill(status, "bad");
  if (status === "cancelled" || status === "rolled_back") return pill(status, "warn");
  return pill(status);
}

function severityPill(severity: string): string {
  if (severity === "error" || severity === "critical") return pill(severity, "bad");
  if (severity === "warning") return pill(severity, "warn");
  return pill(severity);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function handleDashboardAction(
  env: Env,
  config: PublicConfig,
  request: Request,
): Promise<Response> {
  const identity = await authenticateDashboard(env, request);
  if (!identity) return redirect("/dashboard/login");

  const form = await request.formData().catch(() => null);
  try {
    await assertCsrf(env, identity.sessionId, form);
  } catch {
    return redirect("/dashboard?page=overview");
  }

  const action = String(form?.get("action") ?? "");
  const ip = clientIp(request);

  try {
    switch (action) {
      case "block_user":
      case "unblock_user": {
        const userId = Number(form?.get("userId") ?? 0);
        const user = await usersRepo.findById(env, userId);
        if (!user) throw new AppError("NOT_FOUND", messages.notFound);
        const targetRoles = await usersRepo.rolesOf(env, user.id);
        if (targetRoles.includes("super_admin") && !identity.roles.includes("super_admin")) {
          throw new AppError("FORBIDDEN", "فقط سوپر‌ادمین می‌تواند سوپر‌ادمین را تغییر دهد.");
        }
        const blocked = action === "block_user";
        await usersRepo.setBlocked(env, user.id, blocked, blocked ? "blocked_by_dashboard" : null);
        await auditRepo.record(env, {
          actorType: "admin",
          actorId: identity.user.id,
          action: blocked ? "user.blocked" : "user.unblocked",
          targetType: "user",
          targetId: user.id,
          severity: "warning",
          ip,
        });
        break;
      }
      case "cancel_job": {
        const jobId = String(form?.get("jobId") ?? "");
        await engines.cancelJob(env, jobId);
        await auditRepo.record(env, {
          actorType: "admin",
          actorId: identity.user.id,
          action: "job.cancelled",
          targetType: "job",
          targetId: jobId,
          severity: "warning",
          ip,
        });
        break;
      }
      case "health_check": {
        const panelId = Number(form?.get("panelId") ?? 0);
        const panel = await panelsRepo.findById(env, panelId);
        if (!panel) throw new AppError("NOT_FOUND", messages.notFound);
        const { checkAndRecord } = await import("../panels/health");
        await checkAndRecord(env, panel);
        await auditRepo.record(env, {
          actorType: "admin",
          actorId: identity.user.id,
          action: "panel.health_check",
          targetType: "panel",
          targetId: panel.uid,
          ip,
        });
        break;
      }
      case "update_plan": {
        const code = String(form?.get("planCode") ?? "");
        const plan = await subsRepo.findPlan(env, code);
        if (!plan) throw new AppError("NOT_FOUND", messages.notFound);
        const numeric = (key: string, fallback: number): number => {
          const raw = String(form?.get(key) ?? "").trim();
          const value = Number(raw);
          return Number.isFinite(value) ? Math.trunc(value) : fallback;
        };
        await subsRepo.updatePlan(env, code, {
          price_toman: Math.max(0, numeric("priceToman", plan.price_toman)),
          max_panels: Math.max(-1, numeric("maxPanels", plan.max_panels)),
          max_accounts: Math.max(-1, numeric("maxAccounts", plan.max_accounts)),
          duration_days: Math.max(0, numeric("durationDays", plan.duration_days)),
          allow_update: form?.get("allowUpdate") ? 1 : 0,
          allow_backup: form?.get("allowBackup") ? 1 : 0,
          is_active: form?.get("isActive") ? 1 : 0,
        });
        await auditRepo.record(env, {
          actorType: "admin",
          actorId: identity.user.id,
          action: "plan.updated",
          targetType: "plan",
          targetId: code,
          severity: "warning",
          ip,
        });
        break;
      }
      case "set_setting": {
        const key = String(form?.get("key") ?? "").trim();
        const value = String(form?.get("value") ?? "");
        if (!/^[a-z0-9_]{2,40}$/.test(key)) throw new AppError("VALIDATION_FAILED", messages.validation);
        await settingsRepo.set(env, key, value.slice(0, 500), identity.user.id);
        await auditRepo.record(env, {
          actorType: "admin",
          actorId: identity.user.id,
          action: "settings.changed",
          targetType: "system_settings",
          targetId: key,
          severity: "warning",
          ip,
        });
        break;
      }
      default:
        throw new AppError("VALIDATION_FAILED", "عملیات ناشناخته است.");
    }
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError("INTERNAL", messages.internal);
    await auditRepo.record(env, {
      actorType: "admin",
      actorId: identity.user.id,
      action: `dashboard.action.failed:${action}`,
      severity: "error",
      ip,
      detail: { code: appError.code },
    });
    return redirect("/dashboard?page=overview");
  }

  const back = String(form?.get("back") ?? "/dashboard");
  return redirect(back.startsWith("/dashboard") ? back : "/dashboard");
}

export async function handleLogout(env: Env, request: Request): Promise<Response> {
  const identity = await authenticateDashboard(env, request);
  if (identity) {
    await logout(env, identity.sessionId);
    await auditRepo.record(env, {
      actorType: "admin",
      actorId: identity.user.id,
      action: "dashboard.logout",
      ip: clientIp(request),
    });
  }
  return new Response(null, { status: 303, headers: { Location: "/dashboard/login", "Set-Cookie": clearCookie() } });
}

// ---------------------------------------------------------------------------
// JSON endpoints used by the dashboard for polling and by uptime monitors
// ---------------------------------------------------------------------------

export async function summaryJson(env: Env, request: Request): Promise<Response> {
  const identity = await authenticateDashboard(env, request);
  if (!identity) return json({ ok: false, error: "unauthorized" }, 401);
  const [panels, jobs, panelStatus, jobStatus] = await Promise.all([
    panelsRepo.countAll(env),
    jobsRepo.activeJobCount(env),
    panelsRepo.countByStatus(env),
    jobsRepo.countByStatus(env),
  ]);
  return json({ ok: true, panels, activeJobs: jobs, panelStatus, jobStatus, serverTime: Date.now() });
}

export async function jobsJson(env: Env, request: Request): Promise<Response> {
  const identity = await authenticateDashboard(env, request);
  if (!identity) return json({ ok: false, error: "unauthorized" }, 401);
  const jobs = await jobsRepo.listForAdmin(env, { limit: 20, offset: 0 });
  return json({
    ok: true,
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      stepsDone: job.steps_done,
      stepsTotal: job.steps_total,
      error: job.error_message,
      updatedAt: job.updated_at,
    })),
  });
}

/** Public, minimal health endpoint — no tenant data, no configuration detail. */
export async function publicHealth(env: Env): Promise<Response> {
  try {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    return json({ ok: row?.ok === 1, version: PRODUCT_VERSION, time: Date.now() });
  } catch {
    return json({ ok: false, version: PRODUCT_VERSION }, 503);
  }
}

export { manager, verifyLoginCode, manager as managers };
