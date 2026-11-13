# به‌روزرسانی خودکار پنل — اعلان، ارتقای یک‌ضربه‌ای و حفظ تغییرات (UPDATES)

این سند چرخهٔ کامل به‌روزرسانی پنل Bee.Hive روی حساب Cloudflare مشتری‌ها را توضیح می‌دهد:
از «نسخهٔ جدید آماده شد» تا «اعلان در تلگرام»، «ارتقا با یک دکمه» و «حفظ تغییرات سفارشی و داده‌ها».

---

## ۱) چرخهٔ به‌روزرسانی در یک نگاه

```
اپراتور نسخهٔ جدید را تأیید می‌کند
  ├─ باندل پچ‌شده در R2 آپلود می‌شود (scripts/upload-panel-artifact.mjs)
  └─ رجیستری panel_versions + متغیرهای PANEL_ARTIFACT_* به‌روز می‌شوند
        │
        ▼
کرون ربات (هر دقیقه) → src/updates/notify.ts
  ├─ پنل‌های فعال با نسخهٔ قدیمی‌تر از نسخهٔ تأییدشده را پیدا می‌کند
  ├ـ برای هر صاحب پنل یک پیام تلگرام می‌فرستد:
  │    «🆙 به‌روزرسانی جدید برای پنل شما در دسترس است …»
  │    [✅ به‌روزرسانی به 3.1.13]  [👁 مشاهده پنل]
  └─ ارسال‌ها را در panels.update_notified_version / update_notice_at ثبت می‌کند
        │
        ▼
مشتری دکمهٔ «به‌روزرسانی» را می‌زند → callback همان panel:update_go
  └─ job استاندارد update اجرا می‌شود (validate → upload_worker → verify → finalize)
       • فقط اسکریپت Worker جایگزین می‌شود
       • پایگاه D1 و داده‌ها دست‌نخورده می‌مانند
       • پیشرفت کار همان‌جا در تلگرام نمایش داده می‌شود (مثل نصب اولیه)
```

---

## ۲) اعلان خودکار در تلگرام

کرون ربات (`src/index.ts`، گام 3.5) در هر گذر، ماژول `runUpdateCheck` را صدا می‌زند. رفتار:

| پارامتر (کلید `system_settings`) | پیش‌فرض | توضیح |
| --- | --- | --- |
| `update_notify_enabled` | `1` | کلید اصلی اعلان؛ از پنل مدیریت ربات (تنظیمات سیستم → 🔔) هم قابل تغییر است |
| `update_notify_interval_hours` | `24` | بعد از اولین اعلان، اگر مشتری هنوز ارتقا نداده باشد، با این فاصله یادآوری می‌شود |
| `update_notify_batch` | `10` | سقف ارسال در هر گذر کرون (محافظت از محدودیت نرخ تلگرام) |
| `update_check_min_minutes` | `30` | فاصلهٔ حداقلی بین دو بررسی کامل (throttle) |

قواعد مهم:

- **فقط نسخهٔ تأییدشده:** مقصد اعلان باید هم در متغیر `PANEL_ARTIFACT_VERSION` باشد و هم ردیف فعالِ آن در `panel_versions` موجود باشد؛ در غیر این صورت اعلانی ارسال نمی‌شود. یعنی اگر باندل در R2 آپلود نشده یا هش ثبت نشده، هیچ مشتری‌ای مزاحم نمی‌شود.
- **بدون تکرار مزاحم:** هر پنل برای هر نسخهٔ جدید دقیقاً یک اعلان می‌گیرد؛ یادآوری بعدی فقط پس از `update_notify_interval_hours`.
- **فقط پنل‌های فعال:** پنل‌های در حال به‌روزرسانی/حذف/ناموفق و صاحبانی که ربات را بلاک کرده‌اند اعلان نمی‌گیرند.
- **صفحهٔ مدیریت:** «پنل مدیریت → تنظیمات سیستم» وضعیت اعلان را نشان می‌دهد و دکمهٔ 🔔 آن را خاموش/روشن می‌کند (`adm:toggle_update_notify`).

---

## ۳) ارتقای یک‌ضربه‌ای به جدیدترین نسخه

دکمهٔ داخل اعلان به همان مسیر به‌روزرسانی دستی وصل است (`panel:update_go:<panelId>` در `src/bot/router.ts`)، بنابراین:

1. `startUpdate` (`src/provisioning/engine.ts`) نسخهٔ مقصد را از `config.artifactVersion` می‌گیرد و یک job استاندارد `update` می‌سازد.
2. مراحل job طبق `planFor("update")`: `validate_account → ensure_subdomain → upload_worker → verify_endpoint → finalize`. یعنی **دقیقاً همان باندل تأییدشدهٔ R2** (با هش ثبت‌شده) روی حساب Cloudflare مشتری مستقر می‌شود.
3. پیشرفت و نتیجه همان‌جا در تلگرام با دکمه‌های «به‌روزرسانی وضعیت» و «لغو» گزارش می‌شود (`src/provisioning/progress.ts`).
4. سقف پلن مشتری (`assertCanUpdate`) و هم‌زمانی سراسری مثل قبل رعایت می‌شود.

دستور به‌روزرسانیِ خودِ ربات (کنترل‌پلن) جدا است و مثل قبل با `npm run deploy` انجام می‌شود.

---

## ۴) حفظ داده‌ها و تغییرات سفارشی (PATCH-1/2)

### داده‌های مشتری

جابِ `update` فقط اسکریپت Worker را دوباره آپلود می‌کند؛ پایگاه D1 مشتری (کاربران پنل، اشتراک‌ها، تنظیمات، کتابخانهٔ External Raw Configs و کلید `external_auto_include`) **دست‌نخورده** می‌ماند. این تضمین در تست‌ها هم قفل شده است:
`tests/integration/update-notify.test.ts → «update data-safety contract»` بررسی می‌کند که برنامهٔ مراحل update هرگز شامل `create_database`، `delete_database`، `restore_database` یا `delete_worker` نباشد.

### تغییرات کدی (پچ‌ها)

پچ‌های BEEHIVE داخل خودِ باندل تأییدشده baked هستند؛ پس هر به‌روزرسانی به «جدیدترین نسخه» همیشه شامل PATCH-1 (قطع کانفیگ‌های اکسترنال برای کاربرِ تمام‌شده) و PATCH-2 (کتابخانهٔ اکسترنال + bulk-apply + auto-include) است.

برای اینکه پچ‌ها **با نسخه‌های بعدی آپ‌استریم** هم حفظ شوند، خط لولهٔ بازتولید در مخزن وجود دارد:

- `panel/patches.json` — تعریف دقیق پچ‌ها به‌صورت جفت‌های find/replace روی **payload رمزگشایی‌شده** (PATCH-1: ۲ جفت، PATCH-2: ۱۳ جفت) به‌همراه متن هدر باندل.
- `scripts/patch-panel-bundle.mjs` — کدک + اعمال پچ:

```bash
# بازسازی باندل پچ‌شده از باندل خام آپ‌استریم (تأییدشده: خروجی بایت‌به‌بایت با باندل فعلی یکسان است)
node scripts/patch-panel-bundle.mjs patch \
  --base panel/beehive-panel-3.1.13-upstream.js \
  --out  panel/beehive-panel-<NEW>.js \
  --expect-sha <sha-256-انتظاری>

# بررسی اینکه یک باندل موجود هر دو پچ را دارد (و گزارش حجم gzip و sha256)
node scripts/patch-panel-bundle.mjs check panel/beehive-panel-3.1.13.js

# رمزگشایی/کدگذاری دستی برای ممیزی
node scripts/patch-panel-bundle.mjs decode panel/beehive-panel-3.1.13.js --out /tmp/payload.js
node scripts/patch-panel-bundle.mjs encode --payload /tmp/payload.js --base panel/beehive-panel-3.1.13.js --out /tmp/roundtrip.js
```

ساختار رمزگذاری باندل (برای درک اسکریپت): payload داخل خط `const cart_box='…'` = متن JS → UTF-8 → XOR با کلید ۱۶ بایتی (از خط `new Uint8Array([...return+n-m...])` استخراج می‌شود) → base64 → هر کاراکتر XOR 93 → escape در قالب رشتهٔ JS. اسکریپت کلید را از خود باندل می‌خواند، پس با تغییر کلید در نسخه‌های بعدی هم کار می‌کند.

**رفتار در برابر تغییر آپ‌استریم:** اگر در نسخهٔ جدید آپ‌استریم، متنی که پچ به آن متصل می‌شود تغییر کرده باشد، اسکریپت **با خطای صریح** متوقف می‌شود (`anchor not found — the upstream bundle has drifted…`). این عمداً این‌طور است: یعنی پچ باید مثل PATCH-1/2 دوباره روی نسخهٔ جدید port شود و definitions در `panel/patches.json` به‌روز گردند؛ هرگز به‌صورت خاموش باندل بدون پچ تولید نمی‌شود.

---

## ۵) چک‌لیست انتشار نسخهٔ جدید پنل

1. باندل خام آپ‌استریم (مثلاً `3.1.14`) را در `panel/` بگذارید.
2. بازسازی پچ‌شده:
   `node scripts/patch-panel-bundle.mjs patch --base panel/beehive-panel-3.1.14-upstream.js --out panel/beehive-panel-3.1.14.js`
   * اگر anchor شکست → پچ را روی نسخهٔ جدید port کنید و `panel/patches.json` را به‌روز کنید (بخش ۴).
3. `node scripts/patch-panel-bundle.mjs check panel/beehive-panel-3.1.14.js` → هر دو گروه `applied`، هدر دارای نشان BEEHIVE-PATCH و `gzip -9 < 3,145,728` بایت (سقف پلن رایگان Workers).
4. هش جدید را ثبت کنید: یک migration مثل `0006` بسازید که `panel_versions` را به هش جدید pin می‌کند و `wrangler.toml` (متغیرهای `PANEL_ARTIFACT_KEY/VERSION/SHA256`) و `vitest.config.ts` را همگام کنید.
5. آپلود و انتشار:
   ```bash
   npm run db:migrate:remote
   node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.14.js
   npm run deploy
   ```
6. همین که کرون بعدی اجرا شود (حداکثر `update_check_min_minutes` + ۱ دقیقه)، صاحب هر پنل قدیمی اعلان «🆙 به‌روزرسانی جدید …» را می‌گیرد و با یک دکمه ارتقا می‌دهد.

---

## ۶) عیب‌یابی

| نشانه | علت محتمل | اقدام |
| --- | --- | --- |
| اعلانی ارسال نمی‌شود | `update_notify_enabled=0` | پنل مدیریت → تنظیمات سیستم → 🔔 |
| اعلان نمی‌آید ولی نسخهٔ جدید ثبت شده | throttle فعال است یا نسخه در `panel_versions` فعال نیست | کلید `update_check_min_minutes` را موقتاً `0` کنید؛ `is_active` ردیف نسخه را بررسی کنید |
| مشتری دکمه را می‌زند ولی خطای «نسخه در دسترس نیست» | باندل در R2 آپلود نشده یا هش نمی‌خواند | دوباره `node scripts/upload-panel-artifact.mjs --file …` را اجرا کنید |
| `patch mode` خطای anchor داد | آپ‌استریم تغییر کرده | پچ را دستی روی نسخهٔ جدید port کنید (بخش ۴) |
| پیام‌ها به صاحب پنل نمی‌رسد | بات بلاک شده | در گذر بعدی کرون دوباره تلاش می‌شود (`failed` در لاگ) |
