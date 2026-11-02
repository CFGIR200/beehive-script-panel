# راه‌اندازی دستی — فقط با داشبورد Cloudflare و ۳ دستور

این نسخه‌ی ساده و «دستی» همان مسیر نصب است: هرکاری که می‌شود با کلیک در داشبورد انجام داد، با کلیک انجام
می‌دهیم و فقط سه جا از ترمینال استفاده می‌کنیم (چون چاره‌ای نیست).

## اول بفهمیم چه چیزی می‌سازیم

```
        تلگرام  ──▶  یک Worker به اسم beehive-bot  ──▶  اکانت Cloudflare مشتری
                            │
                            ├── D1  «beehive_bot»      ← اطلاعات ربات
                            ├── KV  «BEEHIVE_CACHE»    ← محدودیت نرخ
                            └── R2  «beehive-artifacts» ← فایل پنل + بکاپ
```

پس در کل: **۳ منبع** (D1، KV، R2) + **۱ ورکر** + **۴ کلید محرمانه** + **۱ ربات تلگرام**.

علامت‌ها: 🖱️ = با کلیک در داشبورد، ⌨️ = در ترمینال (PowerShell) داخل پوشه‌ی پروژه.

---

## 🖱️ مرحله ۱ — سه منبع را بسازید (۳ کلیک)

وارد **dash.cloudflare.com** شوید.

| منبع | مسیر در داشبورد | چه چیزی بسازید |
|---|---|---|
| D1 | منوی چپ → **Workers & Pages** → تب **D1 SQL Database** → **Create** | نام: `beehive_bot` |
| KV | منوی چپ → **Workers & Pages** → تب **KV** → **Create a namespace** | نام: `BEEHIVE_CACHE` |
| R2 | منوی چپ → **R2 Object Storage** → **Create bucket** | نام: `beehive-artifacts` |

بعد از ساختن D1، روی `beehive_bot` کلیک کنید؛ بالای صفحه یک **UUID** می‌بینید (شبیه
`a1b2c3d4-1234-...`). کپی کنید → این می‌شود `database_id`.

بعد از ساختن KV، پشت نامش یک **ID** هست (شبیه `0f1e2d3c...`). کپی کنید → این می‌شود `KV id`.

> اگر منوی چپ را پیدا نمی‌کنید: آدرس مستقیم `dash.cloudflare.com` → بعد از ورود، منو بالا-چپ است.

---

## 🖱️ مرحله ۲ — فایل `wrangler.toml` را پر کنید (با Notepad)

در پوشه‌ی پروژه، فایل `wrangler.toml` را با Notepad باز کنید و **۵ خط** را عوض کنید:

```toml
database_id = "a1b2c3d4-..."          # UUID مرحله ۱ (بخش [[d1_databases]])

id = "0f1e2d3c..."                    # ID کش (بخش [[kv_namespaces]])

PUBLIC_BASE_URL = "https://beehive-bot.<زیردامنه‌ی خودتان>.workers.dev"
BOT_USERNAME = "یوزرنیم ربات، بدون @"
BOOTSTRAP_ADMIN_TELEGRAM_ID = "آیدی عددی خودتان"
```

زیردامنه‌ی خودتان را از داشبورد بردارید: **Workers & Pages** → در همان صفحه، زیر عنوان، نوشته
`Your subdomain: xxxxx.workers.dev`. آدرس نهایی ورکر همیشه `https://<اسم ورکر>.<زیردامنه>.workers.dev` است و
اسم ورکر ما `beehive-bot` است.

> هنوز نمی‌دانید آدرس نهایی چه می‌شود؟ اشکالی ندارد: این خط را فعلاً رها کنید، مرحله ۶ آدرس واقعی را نشان
> می‌دهد؛ بعد همان را اینجا بگذارید و یک‌بار دیگر deploy کنید.

آیدی عددی خودتان: در تلگرام به **@userinfobot** پیام بدهید.

---

## 🖱️ مرحله ۳ — چهار کلید محرمانه را اضافه کنید (با کلیک)

⚠️ این مرحله را قبل از deploy انجام ندهید؛ چون ورکر باید وجود داشته باشد.
پس **اول مرحله ۴ را انجام دهید، بعد برگردید اینجا.**

مسیر: **Workers & Pages** → روی ورکر `beehive-bot` کلیک → تب **Settings** → بخش
**Variables and Secrets** → **Add** → نوع را **Secret** بگذارید → نام و مقدار را وارد کنید.

چهار ردیف اضافه کنید:

| نام (Name) | مقدار (Value) |
|---|---|
| `TELEGRAM_BOT_TOKEN` | توکنی که @BotFather داد |
| `TELEGRAM_WEBHOOK_SECRET` | یک رشته‌ی تصادفی، حداقل ۱۶ کاراکتر (مثلاً ۴۸ کاراکتر hex) |
| `CREDENTIAL_ENCRYPTION_KEY` | base64 دقیقاً ۳۲ بایتی |
| `SESSION_SIGNING_KEY` | base64 دقیقاً ۳۲ بایتی |

برای ساختن دو مقدار base64، در ترمینال:

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))   # بار اول
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))   # بار دوم
```

و برای رشته‌ی webhook:

```powershell
-join ((1..48) | ForEach-Object { "0123456789abcdef"[(Get-Random -Maximum 16)] })
```

هر دو مقدار base64 را در یک برنامه‌ی مدیریت رمز ذخیره کنید (اگر `CREDENTIAL_ENCRYPTION_KEY` گم شود،
توکن‌های وصل‌شده‌ی مشتری‌ها دیگر قابل بازگشایی نیستند).

> معادل ترمینی همین مرحله (اگر کلیک سخت است):
> ```powershell
> npx wrangler secret put TELEGRAM_BOT_TOKEN
> npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
> npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
> npx wrangler secret put SESSION_SIGNING_KEY
> npx wrangler secret list      # چک
> ```

---

## ⌨️ مرحله ۴ — اولین deploy (دستور اول از سه دستور)

```powershell
npm install --no-audit --no-fund
npm run deploy
```

آخرش یک آدرس چاپ می‌شود، مثل:

```
https://beehive-bot.your-subdomain.workers.dev
```

همین آدرس را در `wrangler.toml` داخل `PUBLIC_BASE_URL` بگذارید (اگر از قبل درست گذاشته بودید، رد شوید) و اگر
عوض کردید یک‌بار دیگر `npm run deploy` بزنید.

حالا برگردید به **مرحله ۳** و چهار کلید را اضافه کنید.

---

## ⌨️ مرحله ۵ — ساخت جدول‌های دیتابیس (دستور دوم از سه دستور)

```powershell
npm run db:migrate:remote
```

چهار migration اجرا می‌شود؛ آخرش می‌نویسد `4 migrations applied`. همین یک دستور، جدول‌ها + پلن‌ها
(free/basic/pro/enterprise) + تنظیمات پیش‌فرض را می‌سازد.

> **اگر واقعاً می‌خواهید دستی و بدون ترمینال باشد:** در داشبورد → D1 → `beehive_bot` → تب **Console**،
> محتوای چهار فایل `migrations/0001_init.sql` تا `0004_web_flows.sql` را **به ترتیب** کپی-پیست و Execute کنید.
> ولی این‌طور جدول `d1_migrations` پر نمی‌شود و migrationهای بعدی دوباره اجرا می‌شوند.
> پس این راه فقط برای شرایط اضطراری است؛ مسیر پیشنهادی همان یک دستور بالاست.

---

## 🖱️ مرحله ۶ — فایل پنل را در R2 بگذارید (با کلیک)

**R2 Object Storage** → روی باکت `beehive-artifacts` کلیک → **Upload** → دکمه‌ی
«**Upload object**» → فایل `panel/beehive-panel-3.1.13.js` را از پوشه‌ی پروژه انتخاب کنید →
در فیلد **Object name** بنویسید:

```
panel/beehive-panel-3.1.13.js
```

(دقیقاً همین مسیر؛ چون در `wrangler.toml` مقدار `PANEL_ARTIFACT_KEY` همین است) → **Upload**.

بعد از آپلود، در لیست فایل روی آن کلیک کنید و **Size** را ببینید: باید
`9,040,717 bytes` باشد. اگر اندازه فرق داشت، فایل ناقص آپلود شده؛ دوباره بگذارید.

> معادل ترمینی: `node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js`
> (این اسکریپت هش را هم چک می‌کند و همان چیزی را که در `wrangler.toml` پین شده تأیید می‌کند.)

---

## 🖱️ مرحله ۷ — وصل کردن تلگرام به ورکر (webhook)

دو راه دارید، هر کدام راحت‌تر بود:

**راه الف — یک دستور:**

```powershell
node scripts/set-webhook.mjs --url https://beehive-bot.your-subdomain.workers.dev --secret <همان TELEGRAM_WEBHOOK_SECRET>
```

**راه ب — دستی در مرورگر (بدون ترمینال):**

این آدرس را بسازید و در مرورگر باز کنید (توکن و secret خودتان را جایگزین کنید):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://beehive-bot.your-subdomain.workers.dev/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

باید صفحه‌ی سفید با این متن بیاید: `{"ok":true,"result":true,"description":"Webhook was set"}`

چک کردن اینکه وصل شده:

```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

باید `"url"` همان آدرس بالا باشد و `"last_error_message"` خالی.

> ⚠️ این آدرس مرورگر شامل توکن ربات است؛ فقط روی کامپیوتر خودتان باز کنید و تاریخچه‌ی مرورگر را بعدش پاک
> کنید. کلیدهای Cloudflare مشتری‌ها هیچ‌وقت این‌طور در URL نمی‌آیند — این فقط توکن خود ربات شماست.

---

## ✅ مرحله ۸ — تست نهایی (۴ دقیقه)

1. در تلگرام ربات را باز کنید → `/start` → باید منوی فارسی بیاید.
2. `/id` → باید همان آیدی مرحله ۲ باشد.
3. تا یک دقیقه صبر کنید، بعد در داشبورد → D1 → `beehive_bot` → **Console** این را اجرا کنید:
   ```sql
   SELECT * FROM user_roles WHERE role = 'super_admin';
   ```
   باید یک ردیف داشته باشد (یعنی شما Super Admin هستید).
4. `https://<آدرس ورکر>/health` را در مرورگر باز کنید → باید `{"ok":true,...}` بدهد.
5. دکمه‌ی **«اتصال Cloudflare»** → ربات یک لینک یک‌بارمصرف می‌فرستد → لینک را باز کنید → توکن Cloudflare را
   **در صفحه‌ی مرورگر** بچسبانید (نه در چت). توکن را از داشبورد Cloudflare بسازید:
   My Profile → **API Tokens** → Create Token، با این سه دسترسی: *Workers Scripts: Edit*، *D1: Edit*،
   *Account Settings: Read* — روی **All accounts** — بدون تاریخ انقضا.
6. **«ساخت پنل جدید»** → اکانت را انتخاب کنید → اسم ورکر بدهید → پیام پیشرفت مراحل می‌آید → آخرش
   لینک پنل + کلید بازیابی.
7. لینک پنل را باز کنید → باید صفحه‌ی Bee.Hive بیاید. لاگین داشبورد وب هم:
   `https://<آدرس ورکر>/dashboard/login`

---

## خلاصه: چه چیزی با کلیک، چه چیزی با دستور

| کار | روش |
|---|---|
| ساخت D1 / KV / R2 | 🖱️ داشبورد |
| پر کردن `wrangler.toml` | 🖱️ Notepad |
| چهار کلید محرمانه | 🖱️ Settings → Variables and Secrets (یا ⌨️ `wrangler secret put`) |
| ساخت جدول‌ها | ⌨️ `npm run db:migrate:remote` (اجباری؛ معادل دستی‌اش ریسک دارد) |
| آپلود فایل پنل | 🖱️ R2 → Upload |
| deploy کردن کد | ⌨️ `npm run deploy` (اجباری — کد TypeScript است و باید build شود) |
| webhook تلگرام | 🖱️ مرورگر با `api.telegram.org` (یا ⌨️ اسکریپت) |

یعنی از ترمینال فقط سه چیز لازم است: **`npm install` + `npm run deploy` + `npm run db:migrate:remote`**
(و اگر خواستید `npm test` برای اطمینان).

---

## دو تله‌ای که همه می‌افتند

1. **`npm audit fix --force` نزنید.** پیام `13 vulnerabilities` را نادیده بگیرید؛ همه‌شان در ابزار تست هستند
   و در ورکری که روی Cloudflare اجرا می‌شود وجود ندارند (`npm audit --omit=dev` → صفر). آن دستور تست‌ها را
   می‌شکند.
2. **توکن Cloudflare را در تلگرام نفرستید.** همیشه از لینک یک‌بارمصرف استفاده کنید. ربات برای همین ساخته
   شده که توکن هیچ‌وقت در چت، لاگ و URL نیاید.
