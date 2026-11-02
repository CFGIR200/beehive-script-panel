# نصب کامل از روی سایت کلادفلر (بدون ترمینال)

این مسیر را برای کسی نوشته‌ام که می‌خواهد **همه‌چیز را با کلیک** انجام دهد و ترمینال باز نکند.

## اول یک واقعیت را روشن کنیم

داشبورد کلادفلر خودش **کامپایلر TypeScript ندارد**. کد این پروژه TypeScript است و باید قبل از deploy به
JavaScript تبدیل شود. پس «فقط داشبورد» یک راه دارد و یک راه دارد:

> **Workers Builds**: کلادفلر کد را از یک ریپازیتوری می‌گیرد، **خودش build می‌کند** و deploy می‌کند.
> یعنی تنها کار شما این است که سورس را در یک ریپازیتوری بگذارید — و این هم **از روی سایت GitHub و با
> کشیدن و رها کردن فایل‌ها** انجام می‌شود، بدون ترمینال.

پس زنجیره‌ی کار این می‌شود:

```
فایل‌ها  ➜  github.com (آپلود با درگ‌واِدراپ)  ➜  Workers Builds در داشبورد کلادفلر  ➜  Worker زنده
```

> اگر GitHub ندارید و نمی‌خواهید بسازید: مسیر ترمینالی `docs/INSTALLATION-FA-MANUAL.md` کوتاه‌تر است
> (کل کار سه دستور است).

---

## 🖱️ مرحله ۱ — فایل‌ها را آماده کنید

فایل `BEEHIVE-BOT-PRODUCTION-v1.0.0.zip` را از حالت فشرده خارج کنید. پوشه‌ی `beehive-bot-1.0.0` را
ببینید. اگر قبلاً `npm install` زده بودید و پوشه‌ی `node_modules` دارد، آن را **پاک کنید** — قرار نیست
آپلود شود.

آنچه باید آپلود شود (۱۳ قلم):

```
src/   migrations/   tests/   docs/   scripts/   panel/
package.json   package-lock.json   tsconfig.json   wrangler.toml
vitest.config.ts   README.md   .gitignore
```

---

## 🖱️ مرحله ۲ — ریپازیتوری در GitHub بسازید

1. وارد **github.com** شوید (اگر حساب ندارید، یک حساب رایگان بسازید).
2. بالا-راست، **+** → **New repository**.
3. نام: `beehive-bot` · نوع: **Private** (مهم: کد را عمومی نکنید) · **Create repository**.
4. در صفحه‌ی خالی که می‌آید، روی **uploading an existing file** کلیک کنید
   (یا **Add file → Upload files**).
5. همه‌ی ۱۳ قلم بالا را با موس بکشید و رها کنید. **پوشه‌ی `node_modules` را نکشید.**
6. پایین صفحه، **Commit changes**.

اگر آپلود پوشه‌ها را قبول نکرد، همین کار را دو-سه بار با زیرپوشه‌ها تکرار کنید (GitHub مسیرها را حفظ
می‌کند).

---

## 🖱️ مرحله ۳ — سه منبع را در داشبورد کلادفلر بسازید

وارد **dash.cloudflare.com** شوید:

| منبع | مسیر | نام |
|---|---|---|
| D1 | Workers & Pages → تب **D1** → **Create** | `beehive_bot` |
| KV | Workers & Pages → تب **KV** → **Create a namespace** | `BEEHIVE_CACHE` |
| R2 | منوی چپ → **R2** → **Create bucket** | `beehive-artifacts` |

روی `beehive_bot` کلیک کنید و **UUID** بالای صفحه را کپی کنید. ID کش را هم از کنار نام namespace بردارید.

---

## 🖱️ مرحله ۴ — `wrangler.toml` را در خود GitHub ویرایش کنید

در ری포، روی `wrangler.toml` کلیک → آیکن **مداد (Edit)** → این پنج خط را عوض کنید:

```toml
database_id = "UUID مرحله ۳"                  # داخل [[d1_databases]]

id = "ID کش مرحله ۳"                          # داخل [[kv_namespaces]]

PUBLIC_BASE_URL = "https://beehive-bot.<زیردامنه>.workers.dev"
BOT_USERNAME = "یوزرنیم ربات بدون @"
BOOTSTRAP_ADMIN_TELEGRAM_ID = "آیدی عددی خودتان"
```

زیردامنه‌ی خودتان: در داشبورد کلادفلر، Workers & Pages → بالای صفحه نوشته
`Your subdomain: xxxxx.workers.dev`. اسم ورکر ما `beehive-bot` است، پس آدرس می‌شود
`https://beehive-bot.xxxxx.workers.dev`.

آیدی عددی خودتان را از **@userinfobot** در تلگرام بگیرید.

پایین صفحه **Commit changes**.

> اگر آدرس نهایی را مطمئن نیستید، بعد از اولین build (مرحله ۵) آن را از داشبورد بردارید، اینجا اصلاح کنید
> و commit بزنید؛ خودش دوباره build و deploy می‌کند.

---

## 🖱️ مرحله ۵ — Worker را به ریپو وصل کنید (این همان «deploy» است)

در داشبورد کلادفلر: **Workers & Pages** → **Create application** → **Continue with GitHub** →
اجازه‌ی دسترسی بدهید → ریپوی `beehive-bot` را انتخاب کنید.

در صفحه‌ی تنظیمات:

| فیلد | مقدار |
|---|---|
| **Project name** | `beehive-bot` (همین اسم، چون در `wrangler.toml` هم همین است) |
| **Build command** | `npm install --no-audit --no-fund` |
| **Deploy command** | `npx wrangler deploy` |
| **Root directory** | خالی بگذارید |

سپس **Deploy** / **Save and Deploy**.

چند دقیقه صبر کنید. در تب **Deployments** → **View build history** می‌بینید که:
`npm install` اجرا شد → `wrangler deploy` موفق شد → یک آدرس `https://beehive-bot.xxxxx.workers.dev` دارد.

⚠️ **`npm audit fix` را در هیچ‌جا نزنید** (نه اینجا، نه روی سیستم خودتان). دلیلش در
`docs/INSTALLATION-FA.md` توضیح داده شده؛ خلاصه اینکه تست‌ها را می‌شکند و روی کد نهایی اثری ندارد.

---

## 🖱️ مرحله ۶ — چهار کلید محرمانه

در داشبورد کلادفلر: **Workers & Pages** → `beehive-bot` → تب **Settings** →
**Variables and Secrets** → **Add** → نوع **Secret**.

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | توکن @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | یک رشته‌ی تصادفی ۴۰+ کاراکتری (حروف و اعداد) |
| `CREDENTIAL_ENCRYPTION_KEY` | base64 دقیقاً ۳۲ بایتی |
| `SESSION_SIGNING_KEY` | base64 دقیقاً ۳۲ بایتی |

برای ساختن دو مقدار base64 بدون ترمینال، می‌توانید از یک تولیدکننده‌ی آنلاین «random 32 bytes base64»
استفاده کنید — یا در PowerShell (یک بار، اختیاری):
`[Convert]::ToBase64String((1..32 | % { Get-Random -Maximum 256 }))`.

بعد از افزودن هر چهار مورد، یک‌بار ورکر را دوباره deploy کنید (تب Deployments → **Retry build** یا یک
commit در GitHub) تا مطمئن شوید همه‌ی متغیرها در runtime دیده می‌شوند. سپس
`https://آدرس-ورکر/health` را باز کنید: باید `{"ok":true,...}` بدهد. اگر
`{"ok":false,"reason":"not_configured","missing":[...]}` دید، یعنی یکی از کلیدها جا افتاده — همان اسم را
اضافه کنید.

---

## 🖱️ مرحله ۷ — جدول‌های دیتابیس را با پیست کردن بسازید

**Workers & Pages** → تب **D1** → `beehive_bot` → تب **Console**.

چهار فایل را **به همین ترتیب** باز کنید، محتوایشان را کپی و در Console پیست و **Execute** کنید:

```
migrations/0001_init.sql
migrations/0002_seed_plans.sql
migrations/0003_seed_settings.sql
migrations/0004_web_flows.sql
```

بعد از این چهار، **یک‌بار دیگر** همین کار را با این فایل بکنید:

```
scripts/d1-manual-bookkeeping.sql
```

این فایل آخر، جدول `d1_migrations` را با همان ساختاری که Wrangler انتظار دارد می‌سازد و چهار migration را
«اجرا شده» علامت می‌زند. اگر این را نزنید، بعداً که خواستید از مسیر ترمینالی
`npm run db:migrate:remote` استفاده کنید، migration‌ها دوباره اجرا می‌شوند و خطای `table already exists`
می‌گیرید.

چک نهایی: در Console این را اجرا کنید و باید **۴** بدهد:

```sql
SELECT COUNT(*) FROM d1_migrations;
```

و این هم باید **۴** بدهد (پلن‌های پیش‌فرض):

```sql
SELECT COUNT(*) FROM subscription_plans;
```

> این مسیر واقعاً تست شده است: پس از پیست کردن چهار فایل + فایل bookkeeping، دستور
> `wrangler d1 migrations apply` پیام `✅ No migrations to apply!` می‌دهد.

---

## 🖱️ مرحله ۸ — فایل پنل را در R2 بگذارید

منوی چپ → **R2** → باکت `beehive-artifacts` → **Upload** → **Upload object** →
فایل `panel/beehive-panel-3.1.13.js` را انتخاب کنید → در فیلد **Object name** دقیقاً بنویسید:

```
panel/beehive-panel-3.1.13.js
```

→ **Upload**.

بعد از آپلود، **Size** را چک کنید: باید `9,040,717 bytes` باشد. اگر کمتر بود، ناقص آپلود شده؛ دوباره
بگذارید.

---

## 🖱️ مرحله ۹ — ربات را به ورکر وصل کنید (webhook)

در مرورگر این آدرس را باز کنید (TOKEN و SECRET خودتان):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://beehive-bot.xxxxx.workers.dev/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

باید ببینید: `{"ok":true,"result":true,"description":"Webhook was set"}`

چک:

```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

`"url"` باید همان آدرس باشد و `"last_error_message"` خالی.

> این URL توکن ربات خودتان را دارد؛ روی کامپیوتر شخصی باز کنید و بعدش تاریخچه‌ی مرورگر را پاک کنید.

---

## ✅ مرحله ۱۰ — تست نهایی

1. در تلگرام `/start` → منوی فارسی.
2. `/id` → همان آیدی مرحله ۴.
3. یک دقیقه صبر، بعد در D1 Console:
   ```sql
   SELECT * FROM user_roles WHERE role = 'super_admin';
   ```
   باید یک ردیف بدهد.
4. **«اتصال Cloudflare»** → لینک یک‌بارمصرف → توکن کلادفلر را در صفحه‌ی مرورگر بچسبانید.
   توکن را با سه دسترسی بسازید: *Workers Scripts: Edit*، *D1: Edit*، *Account Settings: Read*، روی
   **All accounts**، بدون انقضا.
5. **«ساخت پنل جدید»** → اکانت → اسم ورکر → پیام پیشرفت → لینک پنل + کلید بازیابی.
6. لینک پنل را باز کنید؛ باید صفحه‌ی Bee.Hive بیاید.
7. داشبورد وب: `https://آدرس-ورکر/dashboard/login` → کد ۶ رقمی در تلگرام می‌آید → وارد شوید.

---

## بعداً چطور چیزی را عوض کنم؟

هر تغییری در این مسیر، فقط یک commit در GitHub است:

| کار | روش |
|---|---|
| عوض کردن یک تنظیم در `wrangler.toml` | GitHub → فایل → مداد → Commit → کلادفلر خودش build می‌کند |
| آپلود نسخه‌ی جدید کد | GitHub → Upload files → Commit |
| عوض کردن یک secret | داشبورد → Settings → Variables and Secrets → Edit → دوباره deploy |
| دیدن لاگ‌ها | داشبورد → Deployments → View build history، و تب **Logs** برای runtime |
| عوض کردن زمان کرون | `wrangler.toml` (بخش `[triggers]`) → commit؛ بعد در Settings → **Trigger Events** چک کنید |

> ⚠️ اگر یک متغیر **غیرمحرمانه** را در داشبورد اضافه کنید، در deploy بعدی ممکن است بازنویسی شود.
> قاعده‌ی ساده: متغیرهای عمومی را در `wrangler.toml` بگذارید، کلیدهای محرمانه را در داشبورد.

---

## اگر build شکست خورد

| پیام در build log | علت | راه‌حل |
|---|---|---|
| `Cannot find module ...` یا `wrangler: not found` | Build command خالی بوده | Build command را `npm install --no-audit --no-fund` بگذارید |
| `Missing entry-point` / `Could not find src/index.ts` | Root directory اشتباه است | Root directory را خالی کنید (کد در ریشه است) |
| `Authentication error` هنگام deploy | دسترسی Workers Builds وصل نشده | Settings → Builds → Disconnect و دوباره Connect کنید |
| build سبز است ولی سایت ۵۰۰ می‌دهد | secret جا افتاده | `/health` را باز کنید؛ اسم‌های `missing` را اضافه کنید |
| `no such table: users` | مرحله ۷ انجام نشده | چهار فایل SQL + bookkeeping را در D1 Console اجرا کنید |
| `database_id` هنوز placeholder است | مرحله ۴ انجام نشده | `wrangler.toml` را در GitHub ویرایش و commit کنید |

نسخه‌ی ترمینالی همین کارها با عیب‌یابی کامل‌تر: `docs/INSTALLATION-FA-MANUAL.md` و
`docs/TROUBLESHOOTING.md`.
