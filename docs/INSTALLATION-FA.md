# راهنمای نصب قدم به قدم — BEE.HIVE BOT

این راهنما برای کسی نوشته شده که می‌خواهد ربات را **روی Cloudflare بالا بیاورد**، بدون دانش قبلی از Workers.
ترتیب را عوض نکنید؛ هر مرحله به مرحله‌ی قبل وابسته است.

> ⏱ زمان تقریبی: ۲۵ تا ۴۰ دقیقه.
> 💳 برای اینکه **پنل‌های مشتری‌ها** هم قابل نصب باشند، حساب Cloudflare باید پلن **Workers Paid** داشته باشد
> (حجم پنل بعد از فشرده‌سازی حدود ۲.۹ مگابایت است و سقف پلن رایگان ۳ مگابایت است).

---

## مرحله ۰ — چیزهایی که قبل از شروع لازم دارید

| مورد | چطور به دست می‌آید |
|---|---|
| حساب Cloudflare | dash.cloudflare.com — ایمیل + رمز |
| Node.js نسخه ۲۰ یا بالاتر | nodejs.org (با `node -v` چک کنید) |
| توکن ربات Telegram | در تلگرام به **@BotFather** پیام بدهید → `/newbot` → نام و یوزرنیم بدهید → توکن می‌گیرید |
| آیدی عددی تلگرام خودتان | در تلگرام به **@userinfobot** پیام بدهید (یک عدد مثل `123456789`) |

⚠️ توکن BotFather و هر کلید دیگری را **هیچ‌وقت** در فایل‌های پروژه، تلگرام، یا گیت نگذارید. جای آن‌ها مرحله ۵ است.

---

## مرحله ۱ — پروژه را باز کنید و چک کنید سالم است

فایل `BEEHIVE-BOT-PRODUCTION-v1.0.0.zip` را از حالت فشرده خارج کنید و داخل پوشه‌اش بروید:

```bash
cd beehive-bot-1.0.0
npm install --no-audit --no-fund
npm test
```

باید بنویسد `Tests 94 passed`. این تضمین می‌کند نسخه‌ای که deploy می‌کنید سالم است.
اگر خطا داد، جلوتر نروید (بخش «اگر گیر کردید» در آخر همین راهنما).

> 🚫 **هرگز `npm audit fix --force` نزنید.**
> اگر بعد از `npm install` پیام `13 vulnerabilities` دیدید، این‌ها همه در ابزارهای
> **توسعه** هستند (تست و deploy)، نه در کدی که روی Cloudflare اجرا می‌شود. خودِ Worker
> هیچ وابستگی npm ندارد؛ با `npm audit --omit=dev` می‌بینید که جواب `0 vulnerabilities` است.
> دستور `--force` بسته‌ی تست (`@cloudflare/vitest-pool-workers`) را به نسخه‌ی `0.23` می‌برد که
> اسمش عوض شده و با این پروژه کار نمی‌کند؛ نتیجه‌اش همین خطاست:
> `Missing "./config" specifier`.

---

## مرحله ۲ — ورود به Cloudflare از ترمینال

```bash
npx wrangler login
```

مرورگر باز می‌شود → حساب Cloudflare را انتخاب کنید → **Allow**.
بعد از این، Wrangler خودش از طرف شما با Cloudflare کار می‌کند و هیچ کلیدی دست شما نیست.

---

## مرحله ۳ — سه منبع Cloudflare بسازید

دقیقاً این سه دستور را بزنید:

```bash
# ۱) دیتابیس اصلی ربات
npx wrangler d1 create beehive_bot

# ۲) کش (محدودیت نرخ و کد یک‌بارمصرف)
npx wrangler kv namespace create BEEHIVE_CACHE

# ۳) باکت R2 (فایل پنل + بکاپ‌ها)
npx wrangler r2 bucket create beehive-artifacts
```

هر دستور چند خط خروجی چاپ می‌کند. **دو عدد** را کپی کنید:

* از دستور اول: `database_id = "xxxxxxxx-xxxx-..."` → این همان `database_id` است
* از دستور دوم: `id = "xxxxxxxx..."` → این `id` کش است

فایل `wrangler.toml` را باز کنید و این دو مقدار را جای placeholder‌ها بگذارید:

```toml
[[d1_databases]]
binding = "DB"
database_name = "beehive_bot"
database_id = "<PANEL_D1_DATABASE_ID>"      # ← عدد اول را اینجا بگذارید

[[kv_namespaces]]
binding = "CACHE"
id = "<KV_NAMESPACE_ID>"                    # ← عدد دوم را اینجا بگذارید
```

باکت R2 اسمش از قبل `beehive-artifacts` است و نیاز به تغییر ندارد.

---

## مرحله ۴ — سه تنظیم عمومی در `wrangler.toml`

در همان فایل، بخش `[vars]` را پیدا کنید و این سه خط را پر کنید:

```toml
PUBLIC_BASE_URL = "https://beehive-bot.<your-subdomain>.workers.dev"
BOT_USERNAME = "your_bot_username"        # بدون @
BOOTSTRAP_ADMIN_TELEGRAM_ID = "123456789" # آیدی عددی خودتان از مرحله ۰
```

`<your-subdomain>` را از داشبورد Cloudflare بردارید: **Workers & Pages** → سمت راست/بالا زیردامنه‌ی
`xxxxx.workers.dev` شما نوشته شده. آدرس نهایی همیشه `https://<اسم‌ورکر>.<زیردامنه>.workers.dev` است و
اسم ورکر ما `beehive-bot` است.

> اگر زیردامنه را پیدا نکردید: فعلاً همین خط را رها کنید، مرحله ۸ که deploy کردید آدرس واقعی را به شما نشان
> می‌دهد؛ بعد برگردید، این خط را درست کنید و یک‌بار دیگر `npm run deploy` بزنید.

چک نهایی: هیچ `<...>` نباید در فایل بماند:

```bash
grep PLACEHOLDER wrangler.toml   # باید خروجی خالی بدهد
```

---

## مرحله ۵ — چهار «Secret» بسازید (مهم‌ترین مرحله)

Secret یعنی مقدار محرمانه‌ای که Cloudflare رمزنگاری‌شده نگه می‌دارد و در فایل پروژه نیست.

اول دو مقدار تصادفی بسازید (اگر Linux/macOS دارید):

```bash
openssl rand -base64 32      # ← این می‌شود CREDENTIAL_ENCRYPTION_KEY  (باید دقیقاً ۳۲ بایت باشد)
openssl rand -base64 32      # ← این می‌شود SESSION_SIGNING_KEY
openssl rand -hex 24         # ← این می‌شود TELEGRAM_WEBHOOK_SECRET
```

روی ویندوز: از PowerShell استفاده کنید:
`[Convert]::ToBase64String((1..32|%{Get-Random -Max 256}))` برای دو کلید اول.

حالا چهار دستور زیر را بزنید؛ هر بار Wrangler مقدار را می‌پرسد، مقدار را paste کنید و Enter:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN          # توکن BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET     # رشته‌ی hex مرحله بالا
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY   # base64 ۳۲ بایتی
npx wrangler secret put SESSION_SIGNING_KEY         # base64 ۳۲ بایتی
```

چک کنید هر چهارتا ثبت شده باشند:

```bash
npx wrangler secret list
```

> 🔐 این چهار مقدار را در یک برنامه‌ی مدیریت رمز (Bitwarden/1Password) ذخیره کنید.
> اگر `CREDENTIAL_ENCRYPTION_KEY` را گم کنید، توکن‌های Cloudflare مشتری‌ها قابل بازگشایی نیستند و همه باید
> دوباره وصل کنند. آن را در فایل داخل پوشه‌ی پروژه ذخیره **نکنید**.

---

## مرحله ۶ — ساخت جدول‌های دیتابیس

```bash
npm run db:migrate:remote
```

چهار migration اجرا می‌شود و آخرش می‌نویسد `4 migrations applied`.
این مرحله پلن‌های `free/basic/pro/enterprise` و تنظیمات پیش‌فرض را هم می‌سازد.

---

## مرحله ۷ — فایل پنل را داخل R2 بگذارید

```bash
node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js
```

خروجی باید این sha256 را نشان بدهد (همان مقداری که در `wrangler.toml` پین شده):

```
b763b2f8b09d16d13f3b4971c1df069c7c428f0955b28fe78f1009515796eab4
```

اگر عدد فرق داشت، یعنی فایل پنل دست‌کاری شده — deploy نکنید.

---

## مرحله ۸ — Deploy

```bash
npm run deploy
```

آخر خروجی یک آدرس مثل این می‌بینید:

```
https://beehive-bot.your-subdomain.workers.dev
```

**این آدرس را با `PUBLIC_BASE_URL` در `wrangler.toml` مقایسه کنید.** اگر یکی نبود، خط را درست کنید و
دوباره `npm run deploy` بزنید. سپس:

```bash
curl https://beehive-bot.your-subdomain.workers.dev/health
```

باید چیزی شبیه `{"ok":true,"version":"1.0.0",...}` برگردد. اگر برگشت، ربات زنده است. ✅

---

## مرحله ۹ — به تلگرام وصل کنید (Webhook)

```bash
node scripts/set-webhook.mjs \
  --url https://beehive-bot.your-subdomain.workers.dev \
  --secret <همان TELEGRAM_WEBHOOK_SECRET مرحله ۵>
```

باید بنویسد `{"ok":true,...}`. از این لحظه پیام‌های تلگرام به ربات می‌رسند.

---

## مرحله ۱۰ — تست نهایی (۵ دقیقه)

1. در تلگرام ربات خودتان را باز کنید → `/start`. باید منوی فارسی بیاید.
2. `/id` بزنید → باید همان آیدی مرحله ۴ باشد.
3. تا ۶۰ ثانیه صبر کنید، بعد نقش ادمین را چک کنید:
   ```bash
   npx wrangler d1 execute beehive_bot --remote \
     --command "SELECT * FROM user_roles WHERE role='super_admin'"
   ```
   باید یک ردیف برگردد. یعنی شما Super Admin هستید.
4. دکمه‌ی **«اتصال Cloudflare»** را بزنید → ربات یک لینک یک‌بارمصرف می‌فرستد.
   لینک را در مرورگر باز کنید و توکن Cloudflare را **در صفحه‌ی مرورگر** paste کنید (نه در چت).
   توکن را از داشبورد Cloudflare بسازید: My Profile → API Tokens → Create Token، با این سه دسترسی:
   *Workers Scripts: Edit* ، *D1: Edit* ، *Account Settings: Read* — و **All accounts** — بدون تاریخ انقضا.
5. **«ساخت پنل جدید»** → اکانت را انتخاب کنید → یک اسم برای ورکر بدهید → پیام پیشرفت مراحل را نشان می‌دهد.
   آخرش لینک پنل + کلید بازیابی می‌آید.
6. لینک پنل را باز کنید؛ باید صفحه‌ی ورود/راه‌اندازی Bee.Hive بیاید.
7. لاگین داشبورد وب: `https://.../dashboard/login` → آیدی تلگرام را بدهید → یک کد ۶ رقمی در تلگرام
   برایتان می‌آید → وارد شوید.

اگر همه‌ی این ۷ مورد درست بود، نصب تمام است. 🎉

---

## اگر گیر کردید

| علامت | علت رایج | راه‌حل |
|---|---|---|
| `Missing "./config" specifier in "@cloudflare/vitest-pool-workers"` | قبلاً `npm audit fix --force` زده شده | پوشه‌ی `node_modules` و فایل `package-lock.json` را پاک کنید و `npm install --no-audit --no-fund` بزنید |
| `npm error ERESOLVE … peer vitest@"^4.1.0"` | همان مشکل بالا | همان راه‌حل بالا؛ `--force` یا `--legacy-peer-deps` نزنید |
| `Not logged in` | مرحله ۲ انجام نشده | `npx wrangler login` |
| `no such table` | مرحله ۶ انجام نشده | `npm run db:migrate:remote` |
| `/health` جواب نمی‌دهد | آدرس اشتباه یا deploy ناموفق | `npx wrangler deployments list` و آدرس خروجی deploy را چک کنید |
| ربات به پیام‌ها جواب نمی‌دهد | Webhook ست نشده یا secret فرق دارد | مرحله ۹ را تکرار کنید؛ secret باید عیناً همان مرحله ۵ باشد |
| خطای `ARTIFACT_INTEGRITY` هنگام ساخت پنل | فایل پنل در R2 نیست یا هش نمی‌خورد | مرحله ۷ را تکرار کنید |
| خطای `CF_FORBIDDEN` هنگام اتصال | توکن Cloudflare سه دسترسی لازم را ندارد | توکن را با سه اسکوپ گفته‌شده و All accounts بسازید |
| پنل نصب نمی‌شود و خطای حجم می‌دهد | پلن رایگان Workers | پلن Workers Paid را فعال کنید |

جزئیات بیشتر: `docs/TROUBLESHOOTING.md` (انگلیسی) و `docs/DEPLOYMENT_CHECKLIST.md` (چک‌لیست کامل).

---

## اگر `npm audit fix --force` را زدید (بازگردانی)

در PowerShell، داخل پوشه‌ی پروژه:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm install --no-audit --no-fund
npm test
```

اگر فایل `package.json` هم دست‌کاری شده (نسخه‌ی `@cloudflare/vitest-pool-workers` شده `^0.23.0`)، ساده‌ترین
راه این است که zip اصلی را دوباره از حالت فشرده خارج کنید و فقط `wrangler.toml` و `.dev.vars` خودتان را
به پوشه‌ی جدید کپی کنید. برای اطمینان از سالم بودن نسخه‌ها:

```powershell
npm run doctor        # اگر نسخه‌ها درست باشند، هیچ خروجی‌ای نمی‌دهد
```

## نکته‌های امنیتی که نباید فراموش شوند

* توکن‌های Cloudflare مشتری‌ها با AES-256-GCM رمز می‌شوند و در هیچ لاگ/پیامی نمی‌آیند — کاری نکنید که این
  خاصیت به‌هم بخورد (مثلاً توکن را در چت از کاربر نپرسید).
* `wrangler.toml` را با کلیدها پر نکنید؛ کلیدها فقط با `wrangler secret put`.
* پوشه‌ی `node_modules` و فایل `.dev.vars` هرگز نباید جایی آپلود شوند.
* هفته‌ای یک‌بار بکاپ دیتابیس ربات: `npx wrangler d1 export beehive_bot --remote --output backup.sql`
