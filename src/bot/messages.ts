/**
 * Persian (fa) copy, in one place so it can be reviewed and translated.
 * Every message is plain text for Telegram HTML parse mode; HTML special
 * characters in dynamic values must be escaped by the caller via escapeTelegram.
 */

import { PRODUCT_NAME, PRODUCT_VERSION } from "../config/constants";
import { escapeTelegram } from "../utils/http";
import { toPersianDigits } from "../utils/time";

export const fa = {
  welcome: (firstName: string) =>
    `سلام ${escapeTelegram(firstName)}! 👋\n\n` +
    `به ربات <b>${PRODUCT_NAME}</b> خوش آمدید 🐝\n\n` +
    `از همین‌جا می‌توانید حساب Cloudflare خودتان را متصل کنید و با چند کلیک ` +
    `پنل <b>Bee.Hive</b> را روی حساب خودتان نصب، مدیریت و به‌روزرسانی کنید. ` +
    `پنل و داده‌های آن کاملاً روی حساب Cloudflare خودتان می‌ماند و ربات به آن‌ها دسترسی مستقیم ندارد.\n\n` +
    `نسخهٔ محصول: <code>${PRODUCT_VERSION}</code>`,

  mainMenu: "از منوی زیر انتخاب کنید:",

  help: (support: string, botUsername: string) =>
    `📚 <b>راهنما</b>\n\n` +
    `<b>۱)</b> از بخش «اتصال Cloudflare» یک لینک امن یک‌بارمصرف بگیرید.\n` +
    `<b>۲)</b> در صفحهٔ بازشده، API Token خود را وارد کنید. ربات هرگز توکن را در تلگرام از شما نمی‌گیرد.\n` +
    `<b>۳)</b> دسترسی‌های لازم: <code>Workers Scripts:Edit</code>، <code>D1:Edit</code> و <code>Account Settings:Read</code>.\n` +
    `<b>۴)</b> بعد از اتصال، «نصب پنل جدید» را بزنید و Account موردنظر را انتخاب کنید.\n\n` +
    `<b>نکتهٔ امنیتی:</b> توکن شما رمزنگاری‌شده ذخیره می‌شود و هیچ‌گاه نمایش داده نمی‌شود. ` +
    `با «قطع اتصال» توکن و اطلاعات رمزنگاری‌شده حذف می‌شوند.\n\n` +
    `پشتیبانی: ${escapeTelegram(support)}\n` +
    `شناسهٔ ربات: @${escapeTelegram(botUsername)}`,

  tokenGuide: (url: string) =>
    `🔗 <b>اتصال حساب Cloudflare — ساخت توکن</b>\n\n` +
    `۱) روی لینک زیر بزنید تا صفحهٔ ساخت توکن با دسترسی‌های لازم باز شود.\n` +
    `۲) نام توکن را همان مقدار پیش‌فرض بگذارید، روی <b>Continue to summary</b> و بعد <b>Create Token</b> بزنید.\n` +
    `۳) توکن را <b>در پیام تلگرام نفرستید</b>؛ به‌جای آن از دکمهٔ «اتصال امن» استفاده کنید.\n\n` +
    `<a href="${escapeTelegram(url)}">باز کردن صفحهٔ ساخت توکن</a>\n\n` +
    `⏱ این لینک یک‌بارمصرف است و بعد از ۱۵ دقیقه منقضی می‌شود.`,

  connectLink: (url: string, minutes: number) =>
    `🔐 <b>لینک اتصال امن</b>\n\n` +
    `توکن Cloudflare را فقط در این صفحه وارد کنید:\n${escapeTelegram(url)}\n\n` +
    `• این لینک یک‌بارمصرف است و ${toPersianDigits(minutes)} دقیقه اعتبار دارد.\n` +
    `• توکن نه در تلگرام و نه در گزارش‌ها ذخیره نمی‌شود.\n` +
    `• بعد از اتصال، همین ربات نتیجه را به شما اطلاع می‌دهد.`,

  connectSuccess: (accountName: string, accountId: string) =>
    `✅ حساب <b>${escapeTelegram(accountName)}</b> با موفقیت متصل شد.\n` +
    `شناسهٔ حساب: <code>${escapeTelegram(accountId)}</code>\n\n` +
    `حالا می‌توانید پنل جدید نصب کنید.`,

  connectPermissionsMissing: (missing: string) =>
    `⚠️ حساب متصل شد، اما این دسترسی‌ها روی توکن فعال نیست:\n${escapeTelegram(missing)}\n\n` +
    `تا زمانی که این دسترسی‌ها اضافه نشوند، نصب و مدیریت پنل انجام نمی‌شود. ` +
    `توکن را با دسترسی کامل بسازید و دوباره متصل کنید.`,

  connectInvalid: "❌ توکن نامعتبر یا منقضی است. لطفاً یک توکن جدید بسازید.",

  accounts: (count: number) =>
    count === 0
      ? "هنوز هیچ حساب Cloudflare متصلی ندارید.\nاز «اتصال Cloudflare» شروع کنید. ☁️"
      : `☁️ <b>حساب‌های متصل</b> (${toPersianDigits(count)})\n\nیک حساب را انتخاب کنید:`,

  accountDetail: (input: {
    name: string;
    accountId: string;
    panels: number;
    permissionsOk: boolean;
    subdomain: string | null;
  }) =>
    `☁️ <b>حساب متصل</b>\n\n` +
    `• نام: <b>${escapeTelegram(input.name)}</b>\n` +
    `• شناسه: <code>${escapeTelegram(input.accountId)}</code>\n` +
    `• دامنهٔ workers.dev: <code>${escapeTelegram(input.subdomain ?? "—")}</code>\n` +
    `• پنل‌های ساخته‌شده: ${toPersianDigits(input.panels)}\n` +
    `• وضعیت دسترسی‌ها: ${input.permissionsOk ? "✅ کامل" : "⚠️ ناقص"}`,

  panelsEmpty: "هنوز پنلی نساخته‌اید.\nبا «نصب پنل جدید» شروع کنید. 🚀",

  panelsList: (count: number) => `📦 <b>پنل‌های شما</b> (${toPersianDigits(count)})\n\nبرای مدیریت، روی پنل بزنید:`,

  panelDetail: (input: {
    workerName: string;
    status: string;
    version: string;
    url: string;
    accountName: string;
    health: string;
    installedAt: string;
    updatedAt: string;
  }) =>
    `🐝 <b>پنل ${escapeTelegram(input.workerName)}</b>\n\n` +
    `• وضعیت: ${escapeTelegram(input.status)}\n` +
    `• نسخه: <code>${escapeTelegram(input.version)}</code>\n` +
    `• آدرس: ${escapeTelegram(input.url)}\n` +
    `• حساب: ${escapeTelegram(input.accountName)}\n` +
    `• سلامت آخرین بررسی: ${escapeTelegram(input.health)}\n` +
    `• تاریخ نصب: ${escapeTelegram(input.installedAt)}\n` +
    `• آخرین تغییر: ${escapeTelegram(input.updatedAt)}`,

  panelNotFound: "پنل موردنظر پیدا نشد.",
  accountNotFound: "حساب Cloudflare موردنظر پیدا نشد. ممکن است اتصال قطع شده باشد.",

  limitReached: (limit: number, current: number) =>
    `🚧 به سقف پلن خود رسیده‌اید.\n` +
    `حداکثر پنل مجاز: ${toPersianDigits(limit)} — تعداد فعلی: ${toPersianDigits(current)}\n` +
    `برای افزایش، پلن خود را ارتقا دهید.`,

  installNotAllowed: "نصب پنل در حال حاضر توسط مدیر سیستم غیرفعال شده است.",
  installDisabled: "در حال حاضر امکان نصب پنل جدید وجود ندارد.",

  installStart: (workerName: string, accountName: string) =>
    `🚀 <b>شروع نصب پنل</b>\n\n` +
    `• نام Worker: <code>${escapeTelegram(workerName)}</code>\n` +
    `• حساب مقصد: <b>${escapeTelegram(accountName)}</b>\n\n` +
    `عملیات در پس‌زمینه اجرا می‌شود و پیشرفت آن همین‌جا به‌روز می‌شود.`,

  installDone: (input: { url: string; workerName: string; recoveryKey: string; dbName: string; version: string }) =>
    `🎉 <b>پنل شما آماده شد!</b>\n\n` +
    `🔗 ${escapeTelegram(input.url)}\n\n` +
    `• شناسهٔ پنل: <code>${escapeTelegram(input.workerName)}</code>\n` +
    `• پایگاه دادهٔ D1: <code>${escapeTelegram(input.dbName)}</code>\n` +
    `• نسخه: <code>${escapeTelegram(input.version)}</code>\n` +
    `• کلید بازیابی: <code>${escapeTelegram(input.recoveryKey)}</code>\n\n` +
    `🔒 این پیام حاوی کلید بازیابی پنل است. آن را در جای امن نگه دارید و سپس پیام را پاک کنید؛ ` +
    `کلید دیگر نمایش داده نمی‌شود.`,

  installRecoveryKeyOnly: (recoveryKey: string) =>
    `🔑 کلید بازیابی پنل (یک‌بار نمایش):\n<code>${escapeTelegram(recoveryKey)}</code>`,

  jobProgress: (input: {
    title: string;
    status: string;
    currentStep: string;
    done: number;
    total: number;
    elapsed: string;
    traceId: string;
  }) =>
    `⏳ <b>${escapeTelegram(input.title)}</b>\n\n` +
    `• وضعیت: ${escapeTelegram(input.status)}\n` +
    `• مرحلهٔ جاری: ${escapeTelegram(input.currentStep)}\n` +
    `• پیشرفت: ${toPersianDigits(input.done)} از ${toPersianDigits(input.total)}\n` +
    `• زمان سپری‌شده: ${escapeTelegram(input.elapsed)}\n` +
    `• شناسهٔ رهگیری: <code>${escapeTelegram(input.traceId)}</code>`,

  jobFailed: (input: { title: string; message: string; traceId: string }) =>
    `❌ <b>${escapeTelegram(input.title)}</b> ناموفق بود.\n\n` +
    `دلیل: ${escapeTelegram(input.message)}\n` +
    `شناسهٔ رهگیری: <code>${escapeTelegram(input.traceId)}</code>\n\n` +
    `اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.`,

  jobCompleted: (title: string) => `✅ <b>${escapeTelegram(title)}</b> با موفقیت انجام شد.`,
  jobCancelled: "لغو شد.",

  stepLabels: {
    validate_account: "بررسی حساب و دسترسی‌ها",
    ensure_subdomain: "بررسی دامنهٔ workers.dev",
    create_database: "ساخت پایگاه دادهٔ D1",
    upload_worker: "بارگذاری Worker پنل",
    configure_schedule: "تنظیم زمان‌بندی (Cron)",
    verify_endpoint: "بررسی سلامت پنل",
    finalize: "ثبت نهایی اطلاعات پنل",
    delete_worker: "حذف Worker",
    delete_database: "حذف پایگاه دادهٔ D1",
    mark_deleted: "ثبت حذف پنل",
    export_database: "دریافت نسخهٔ پشتیبان",
    store_backup: "ذخیرهٔ نسخهٔ پشتیبان",
    preflight: "بررسی مقدماتی",
    restore_database: "بازیابی پایگاه داده",
    enable_workers_dev: "فعال‌سازی دسترسی عمومی",
    health_check: "بررسی سلامت",
  } as Record<string, string>,

  deleteWarn: (input: { workerName: string; dbName: string }) =>
    `🗑 <b>حذف پنل — تأیید نهایی</b>\n\n` +
    `با تأیید، این منابع از حساب Cloudflare شما حذف می‌شوند:\n` +
    `• Worker: <code>${escapeTelegram(input.workerName)}</code>\n` +
    `• پایگاه دادهٔ D1: <code>${escapeTelegram(input.dbName)}</code>\n` +
    `• زمان‌بندی (Cron) مربوط به همین Worker\n\n` +
    `⚠️ این عملیات <b>غیرقابل بازگشت</b> است و دادهٔ کاربران پنل از بین می‌رود. ` +
    `اگر می‌خواهید نگه دارید، اول «پشتیبان‌گیری» را اجرا کنید.`,

  deleteDone: (workerName: string) => `✅ پنل <b>${escapeTelegram(workerName)}</b> و منابع آن حذف شد.`,

  updateNoop: (version: string) => `پنل شما از قبل روی نسخهٔ <code>${escapeTelegram(version)}</code> است.`,
  updateStart: (version: string) => `🔄 <b>به‌روزرسانی پنل</b> به نسخهٔ <code>${escapeTelegram(version)}</code> شروع شد.`,
  updateNotAllowed: "پلن فعلی شما امکان به‌روزرسانی ندارد.",

  // Bulk update — "update all opened panels" straight from the bot (UPDALL-1).
  updateAllConfirm: (input: { count: number; to: string }) =>
    `🔄 <b>به‌روزرسانی همهٔ پنل‌ها</b>\n\n` +
    `${toPersianDigits(input.count)} پنل شما روی نسخهٔ قدیمی‌تر هستند و می‌توانند به نسخهٔ ` +
    `<code>${escapeTelegram(input.to)}</code> ارتقا یابند.\n\n` +
    `فقط اسکریپت Worker جایگزین می‌شود؛ پایگاه دادهٔ هر پنل (کاربران، تنظیمات و کتابخانهٔ ` +
    `کانفیگ‌های اکسترنال) و تغییرات سفارشی نسخه حفظ می‌شود.\n\nادامه می‌دهید؟`,
  updateAllNone: "✅ همهٔ پنل‌های شما روی آخرین نسخهٔ تأییدشده هستند.",
  updateAllSummary: (input: { queued: number; busy: number; plan: number; capacity: number; other: number; to: string }) => {
    const lines = [`🚀 به‌روزرسانی ${toPersianDigits(input.queued)} پنل به نسخهٔ <code>${escapeTelegram(input.to)}</code> آغاز شد.`];
    if (input.busy > 0) lines.push(`⏳ ${toPersianDigits(input.busy)} پنل در حال انجام کار دیگر بودند — بعداً دوباره تلاش کنید.`);
    if (input.plan > 0) lines.push(`💳 ${toPersianDigits(input.plan)} پنل به‌دلیل محدودیت پلن رد شدند.`);
    if (input.capacity > 0) lines.push(`🌐 ظرفیت سرور پر بود؛ ${toPersianDigits(input.capacity)} پنل در صف بعدی به‌روزرسانی می‌شوند.`);
    if (input.other > 0) lines.push(`• ${toPersianDigits(input.other)} پنل به‌دلیل وضعیت خاص رد شدند.`);
    lines.push("پیشرفت هر پنل به‌صورت پیام جداگانه اعلام می‌شود.");
    return lines.join("\n");
  },

  // Admin: same bulk update across every tenant's opened panels.
  adminUpdateAllConfirm: (input: { count: number; to: string }) =>
    `🔄 <b>به‌روزرسانی همهٔ پنل‌های باز سیستم</b>\n\n` +
    `${toPersianDigits(input.count)} پنل فعال در کل سیستم روی نسخهٔ قدیمی‌تر هستند.\n` +
    `نسخهٔ مقصد: <code>${escapeTelegram(input.to)}</code>\n\n` +
    `برای هر صاحب پنل، پیام پیشرفت در گفت‌وگوی خودش ارسال می‌شود و داده‌ها دست‌نخورده می‌مانند.\n\nادامه می‌دهید؟`,
  adminUpdateAllSummary: (input: { queued: number; busy: number; plan: number; capacity: number; other: number; to: string }) => {
    const lines = [`🚀 به‌روزرسانی ${toPersianDigits(input.queued)} پنل به نسخهٔ <code>${escapeTelegram(input.to)}</code> در صف قرار گرفت.`];
    if (input.busy > 0) lines.push(`⏳ ${toPersianDigits(input.busy)} پنل مشغول بودند.`);
    if (input.plan > 0) lines.push(`💳 ${toPersianDigits(input.plan)} پنل به‌دلیل پلن صاحبشان رد شدند.`);
    if (input.capacity > 0) lines.push(`🌐 ظرفیت سرور پر بود؛ ${toPersianDigits(input.capacity)} پنل در اجر بعدی پردازش می‌شوند.`);
    if (input.other > 0) lines.push(`• ${toPersianDigits(input.other)} پنل به‌دلیل وضعیت خاص رد شدند.`);
    return lines.join("\n");
  },

  // Cron-driven notice: a newer approved panel version is available. The
  // one-tap button routes into panel:update_go, so the update runs through the
  // exact same job pipeline as the manual flow.
  updateNotifyAvailable: (input: { workerName: string; from: string; to: string }) =>
    `🆙 <b>به‌روزرسانی جدید برای پنل شما در دسترس است</b>\n\n` +
    `• پنل: <b>${escapeTelegram(input.workerName)}</b>\n` +
    `• نسخهٔ نصب‌شده: <code>${escapeTelegram(input.from)}</code>\n` +
    `• نسخهٔ جدید: <code>${escapeTelegram(input.to)}</code>\n\n` +
    `با زدن دکمهٔ زیر، پنل روی حساب Cloudflare خودتان به نسخهٔ جدید ارتقا می‌یابد.\n` +
    `داده‌های پنل (کاربران، تنظیمات و کتابخانهٔ کانفیگ‌های اکسترنال) روی همان پایگاه D1 باقی می‌مانند و ` +
    `تغییرات سفارشی نسخه نیز در به‌روزرسانی حفظ می‌شود.`,

  backupNotAllowed: "پلن فعلی شما امکان پشتیبان‌گیری ندارد.",
  backupStart: "💾 تهیهٔ نسخهٔ پشتیبان شروع شد. نتیجه اطلاع داده می‌شود.",
  backupDone: (input: { size: string; backupId: string }) =>
    `✅ نسخهٔ پشتیبان آماده شد.\n• حجم: ${escapeTelegram(input.size)}\n• شناسه: <code>${escapeTelegram(input.backupId)}</code>`,
  backupEmpty: "نسخهٔ پشتیبانی برای این پنل موجود نیست.",

  restoreStart: "♻️ بازیابی نسخهٔ پشتیبان شروع شد.",
  restoreWarn: "⚠️ بازیابی، دادهٔ فعلی پایگاه دادهٔ پنل را جایگزین می‌کند. ادامه می‌دهید؟",

  healthOk: (latency: string) => `✅ پنل پاسخ می‌دهد (${escapeTelegram(latency)}).`,
  healthFail: (reason: string) => `⚠️ پنل پاسخ سالم نداد: ${escapeTelegram(reason)}`,

  subscription: (input: { planName: string; status: string; expiresAt: string; limits: string[] }) =>
    `💳 <b>اشتراک شما</b>\n\n` +
    `• پلن: <b>${escapeTelegram(input.planName)}</b>\n` +
    `• وضعیت: ${escapeTelegram(input.status)}\n` +
    `• انقضا: ${escapeTelegram(input.expiresAt)}\n\n` +
    `<b>محدودیت‌ها:</b>\n${input.limits.map((line) => `• ${escapeTelegram(line)}`).join("\n")}`,

  status: (input: {
    panels: number;
    accounts: number;
    activeJobs: number;
    healthy: number;
    degraded: number;
    installEnabled: boolean;
  }) =>
    `📊 <b>وضعیت سرویس‌ها</b>\n\n` +
    `• پنل‌های شما: ${toPersianDigits(input.panels)}\n` +
    `• حساب‌های متصل: ${toPersianDigits(input.accounts)}\n` +
    `• عملیات در حال اجرا: ${toPersianDigits(input.activeJobs)}\n` +
    `• پنل سالم: ${toPersianDigits(input.healthy)} — نیازمند بررسی: ${toPersianDigits(input.degraded)}\n` +
    `• نصب پنل جدید: ${input.installEnabled ? "فعال" : "غیرفعال"}`,

  rateLimited: "⏳ کمی آرام‌تر! تعداد درخواست‌ها زیاد است. چند لحظه بعد دوباره تلاش کنید.",
  blocked: "⛔ دسترسی شما به ربات مسدود شده است. برای پیگیری با پشتیبانی تماس بگیرید.",
  unknownCommand: "متوجه نشدم. از منوی زیر استفاده کنید یا /help را بزنید.",
  cancelled: "عملیات لغو شد.",
  genericError: "خطایی رخ داد. لطفاً دوباره تلاش کنید.",
  sessionExpired: "زمان این مرحله به پایان رسید. از منو دوباره شروع کنید.",

  // ---- admin ------------------------------------------------------------
  adminHome: (input: { users: number; panels: number; jobs: number; errors: number }) =>
    `🛠 <b>پنل مدیریت</b>\n\n` +
    `• کاربران: ${toPersianDigits(input.users)}\n` +
    `• پنل‌ها: ${toPersianDigits(input.panels)}\n` +
    `• عملیات فعال: ${toPersianDigits(input.jobs)}\n` +
    `• خطاهای ۲۴ ساعت گذشته: ${toPersianDigits(input.errors)}`,
  adminOnly: "این بخش فقط برای مدیران است.",
  broadcastAsk: "متن پیام همگانی را بفرستید. برای لغو /cancel را بزنید.",
  broadcastConfirm: (recipients: number, preview: string) =>
    `📣 ارسال به ${toPersianDigits(recipients)} کاربر.\n\nپیش‌نمایش:\n${escapeTelegram(preview.slice(0, 400))}\n\nتأیید می‌کنید؟`,
  broadcastStarted: "ارسال همگانی آغاز شد؛ نتیجه پس از پایان اطلاع داده می‌شود.",
  broadcastDone: (sent: number, failed: number) =>
    `📣 ارسال همگانی پایان یافت.\n• موفق: ${toPersianDigits(sent)}\n• ناموفق: ${toPersianDigits(failed)}`,
  adminUserCard: (input: {
    id: number;
    telegramId: number;
    username: string | null;
    plan: string;
    panels: number;
    blocked: boolean;
    roles: string;
    joinedAt: string;
  }) =>
    `👤 <b>کاربر</b>\n\n` +
    `• شناسهٔ داخلی: <code>${input.id}</code>\n` +
    `• تلگرام: <code>${input.telegramId}</code>\n` +
    `• نام کاربری: ${escapeTelegram(input.username ?? "—")}\n` +
    `• نقش‌ها: ${escapeTelegram(input.roles)}\n` +
    `• پلن: ${escapeTelegram(input.plan)}\n` +
    `• تعداد پنل: ${toPersianDigits(input.panels)}\n` +
    `• وضعیت: ${input.blocked ? "⛔ مسدود" : "✅ فعال"}\n` +
    `• عضویت: ${escapeTelegram(input.joinedAt)}`,
  adminUserNotFound: "کاربری با این مشخصات پیدا نشد.",
  adminSearchAsk: "شناسهٔ عددی تلگرام یا نام کاربری (بدون @) را بفرستید:",
  adminSubGranted: (plan: string) => `✅ پلن <b>${escapeTelegram(plan)}</b> برای کاربر ثبت شد.`,
  adminBlocked: "کاربر مسدود شد.",
  adminUnblocked: "مسدودیت کاربر برداشته شد.",
} as const;
