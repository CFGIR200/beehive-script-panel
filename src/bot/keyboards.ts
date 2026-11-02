/**
 * Keyboard builders.
 *
 * Callback data convention: `namespace:action[:arg…]`, each segment ≤ 24 chars
 * and the whole payload ≤ 64 bytes (Telegram limit). `parseCallback` is the only
 * place that decodes it, and it rejects anything unexpected.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup } from "./telegram";

export const CALLBACK_LIMIT = 64;

export function cb(...parts: Array<string | number>): string {
  const data = parts.map((part) => String(part)).join(":");
  if (data.length > CALLBACK_LIMIT) {
    throw new Error(`callback data too long (${data.length}): ${data}`);
  }
  return data;
}

export interface ParsedCallback {
  namespace: string;
  action: string;
  args: string[];
}

export function parseCallback(data: string | undefined): ParsedCallback | null {
  if (!data || data.length > CALLBACK_LIMIT) return null;
  const parts = data.split(":");
  if (parts.length < 2) return null;
  const namespace = parts[0]!;
  const action = parts[1]!;
  if (!/^[a-z_]{1,16}$/.test(namespace) || !/^[a-z_0-9]{1,24}$/.test(action)) return null;
  return { namespace, action, args: parts.slice(2) };
}

function keyboard(rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  return { inline_keyboard: rows.filter((row) => row.length > 0) };
}

function button(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: data };
}

function link(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

// ---------------------------------------------------------------------------
// User keyboards
// ---------------------------------------------------------------------------

export const mainMenuKeyboard = (isStaff: boolean): InlineKeyboardMarkup =>
  keyboard([
    [button("🚀 ساخت پنل جدید", cb("panel", "new"))],
    [button("📦 پنل‌های من", cb("panel", "list")), button("☁️ اتصال Cloudflare", cb("cf", "list"))],
    [button("💳 اشتراک و پلن", cb("sub", "view")), button("📊 وضعیت سرویس‌ها", cb("status", "view"))],
    [button("📚 راهنما", cb("help", "view"))],
    ...(isStaff ? [[button("🛠 پنل مدیریت", cb("adm", "home"))]] : []),
  ]);

export const backToMainKeyboard = (): InlineKeyboardMarkup => keyboard([[button("🏠 منوی اصلی", cb("menu", "main"))]]);

export const connectKeyboard = (tokenCreateUrl: string): InlineKeyboardMarkup =>
  keyboard([
    [button("🔐 دریافت لینک اتصال امن", cb("cf", "link"))],
    [link("🧭 ساخت توکن در Cloudflare", tokenCreateUrl)],
    [button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const tokenPermissionHelpKeyboard = (): InlineKeyboardMarkup =>
  keyboard([
    [button("✅ متوجه شدم، لینک اتصال را بده", cb("cf", "link"))],
    [button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const accountsKeyboard = (
  accounts: Array<{ id: number; name: string; panels: number }>,
): InlineKeyboardMarkup =>
  keyboard([
    ...accounts.map((account) => [
      button(`☁️ ${truncate(account.name, 26)} · ${account.panels} پنل`, cb("cf", "pick", account.id)),
    ]),
    [button("➕ اتصال حساب دیگر", cb("cf", "link"))],
    [button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const accountDetailKeyboard = (accountRef: number): InlineKeyboardMarkup =>
  keyboard([
    [button("🚀 نصب پنل روی این حساب", cb("panel", "new", accountRef))],
    [button("🗑 قطع اتصال", cb("cf", "disconnect", accountRef))],
    [button("🔙 بازگشت", cb("cf", "list")), button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const panelsKeyboard = (
  panels: Array<{ id: number; workerName: string; status: string }>,
): InlineKeyboardMarkup =>
  keyboard([
    ...panels.map((panel) => [
      button(`${statusEmoji(panel.status)} ${truncate(panel.workerName, 30)}`, cb("panel", "view", panel.id)),
    ]),
    [button("🚀 نصب پنل جدید", cb("panel", "new"))],
    [button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const panelActionsKeyboard = (panelId: number, opts: { canUpdate: boolean; canBackup: boolean; url: string | null }): InlineKeyboardMarkup =>
  keyboard([
    ...(opts.url ? [[link("🔗 باز کردن پنل", opts.url)]] : []),
    [button("🩺 بررسی سلامت", cb("panel", "health", panelId)), button("👁 کلید بازیابی", cb("panel", "reveal", panelId))],
    ...(opts.canUpdate
      ? [[button("🔄 به‌روزرسانی / نصب مجدد", cb("panel", "update", panelId))]]
      : []),
    ...(opts.canBackup
      ? [
          [button("💾 پشتیبان‌گیری", cb("panel", "backup", panelId))],
          [button("♻️ بازیابی پشتیبان", cb("panel", "restores", panelId))],
        ]
      : []),
    [button("🗑 حذف پنل", cb("panel", "delete", panelId))],
    [button("🔙 پنل‌های من", cb("panel", "list")), button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const confirmDeleteKeyboard = (panelId: number): InlineKeyboardMarkup =>
  keyboard([
    [button("❌ بله، حذف کن", cb("panel", "delete_yes", panelId))],
    [button("🔙 انصراف", cb("panel", "view", panelId))],
  ]);

export const confirmRestoreKeyboard = (panelId: number, backupId: number): InlineKeyboardMarkup =>
  keyboard([
    [button("♻️ بله، بازیابی کن", cb("panel", "restore_yes", panelId, backupId))],
    [button("🔙 انصراف", cb("panel", "view", panelId))],
  ]);

export const backupsKeyboard = (
  panelId: number,
  backups: Array<{ id: number; createdAt: string; size: string }>,
): InlineKeyboardMarkup =>
  keyboard([
    ...backups.map((backup) => [
      button(`♻️ بازیابی ${backup.createdAt} · ${backup.size}`, cb("panel", "restore", panelId, backup.id)),
    ]),
    [button("💾 پشتیبان جدید", cb("panel", "backup", panelId))],
    [button("🔙 بازگشت", cb("panel", "view", panelId))],
  ]);

export const jobKeyboard = (jobId: string): InlineKeyboardMarkup =>
  keyboard([
    [button("🔄 به‌روزرسانی وضعیت", cb("job", "refresh", jobId))],
    [button("🏠 منوی اصلی", cb("menu", "main"))],
  ]);

export const subscriptionKeyboard = (): InlineKeyboardMarkup =>
  keyboard([[button("🛠 پشتیبانی", cb("help", "view"))], [button("🏠 منوی اصلی", cb("menu", "main"))]]);

// ---------------------------------------------------------------------------
// Admin keyboards
// ---------------------------------------------------------------------------

export const adminKeyboard = (): InlineKeyboardMarkup =>
  keyboard([
    [button("📊 داشبورد", cb("adm", "home")), button("👥 کاربران", cb("adm", "users"))],
    [button("🗂 عملیات", cb("adm", "jobs")), button("💳 پلن‌ها", cb("adm", "plans"))],
    [button("⚙️ تنظیمات", cb("adm", "settings")), button("🩺 زیرساخت", cb("adm", "infra"))],
    [button("📣 پیام همگانی", cb("adm", "broadcast"))],
    [button("🏠 منوی کاربری", cb("menu", "main"))],
  ]);

export const adminUsersKeyboard = (page: number, hasNext: boolean): InlineKeyboardMarkup =>
  keyboard([
    [button("🔍 جست‌وجوی کاربر", cb("adm", "search"))],
    [
      ...(page > 1 ? [button("◀️ قبلی", cb("adm", "users", page - 1))] : []),
      ...(hasNext ? [button("بعدی ▶️", cb("adm", "users", page + 1))] : []),
    ],
    [button("🔙 پنل مدیریت", cb("adm", "home"))],
  ]);

export const adminUserKeyboard = (userId: number, blocked: boolean): InlineKeyboardMarkup =>
  keyboard([
    [button("💳 تغییر پلن", cb("adm", "plan_pick", userId))],
    [button(blocked ? "♻️ رفع مسدودی" : "⛔ مسدودسازی", cb("adm", blocked ? "unblock" : "block", userId))],
    [button("🔙 کاربران", cb("adm", "users"))],
  ]);

export const adminPlansKeyboard = (plans: Array<{ code: string; name: string }>): InlineKeyboardMarkup =>
  keyboard([
    ...plans.map((plan) => [button(`💳 ${plan.name}`, cb("adm", "plan_edit", plan.code))]),
    [button("🔙 پنل مدیریت", cb("adm", "home"))],
  ]);

export const adminPlanKeyboard = (code: string): InlineKeyboardMarkup =>
  keyboard([
    [button("✏️ تغییر سقف پنل", cb("adm", "plan_limit", code))],
    [button("💵 تغییر قیمت", cb("adm", "plan_price", code))],
    [button("🔙 پلن‌ها", cb("adm", "plans"))],
  ]);

export const adminGrantPlanKeyboard = (userId: number, plans: Array<{ code: string; name: string }>): InlineKeyboardMarkup =>
  keyboard([
    ...plans.map((plan) => [button(`✅ ${plan.name}`, cb("adm", "plan_grant", userId, plan.code))]),
    [button("🔙 بازگشت", cb("adm", "user", userId))],
  ]);

export const adminJobsKeyboard = (page: number, hasNext: boolean): InlineKeyboardMarkup =>
  keyboard([
    [
      ...(page > 1 ? [button("◀️ قبلی", cb("adm", "jobs", page - 1))] : []),
      ...(hasNext ? [button("بعدی ▶️", cb("adm", "jobs", page + 1))] : []),
    ],
    [button("🔙 پنل مدیریت", cb("adm", "home"))],
  ]);

export const cancelKeyboard = (): InlineKeyboardMarkup =>
  keyboard([[button("✖️ لغو", cb("flow", "cancel"))]]);

export const confirmBroadcastKeyboard = (): InlineKeyboardMarkup =>
  keyboard([
    [button("📣 ارسال کن", cb("adm", "broadcast_yes"))],
    [button("✖️ انصراف", cb("adm", "home"))],
  ]);

// ---------------------------------------------------------------------------
// Reply keyboard (persistent bottom menu)
// ---------------------------------------------------------------------------

export const replyMenu = (isStaff: boolean): ReplyKeyboardMarkup => ({
  keyboard: [
    [{ text: "🚀 نصب پنل جدید" }, { text: "📦 پنل‌های من" }],
    [{ text: "☁️ اتصال Cloudflare" }, { text: "📊 وضعیت" }],
    [{ text: "💳 اشتراک" }, { text: "📚 راهنما" }],
    ...(isStaff ? [[{ text: "🛠 پنل مدیریت" }]] : []),
  ],
  resize_keyboard: true,
  is_persistent: true,
});

export const removeReplyMenu: ReplyKeyboardMarkup = { keyboard: [], resize_keyboard: true };

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function statusEmoji(status: string): string {
  switch (status) {
    case "active":
      return "🟢";
    case "degraded":
      return "🟡";
    case "provisioning":
    case "updating":
    case "deleting":
      return "⏳";
    case "failed":
      return "🔴";
    default:
      return "⚪️";
  }
}

export function statusLabelFa(status: string): string {
  switch (status) {
    case "active":
      return "فعال";
    case "degraded":
      return "نیازمند بررسی";
    case "provisioning":
      return "در حال نصب";
    case "updating":
      return "در حال به‌روزرسانی";
    case "deleting":
      return "در حال حذف";
    case "failed":
      return "ناموفق";
    case "deleted":
      return "حذف‌شده";
    default:
      return status;
  }
}

/** Reply-keyboard button texts, mapped back to intents. */
export const REPLY_INTENTS: Record<string, string> = {
  "🚀 نصب پنل جدید": "install",
  "📦 پنل‌های من": "panels",
  "☁️ اتصال Cloudflare": "connect",
  "📊 وضعیت": "status",
  "💳 اشتراک": "subscription",
  "📚 راهنما": "help",
  "🛠 پنل مدیریت": "admin",
};
