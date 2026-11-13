-- Migration 0009 — BEEHIVE-UPDRELEASE-1: panel release 3.1.14 + release changelog.
--
-- 3.1.14 is the first BEEHIVE release build: the patched 3.1.13 artifact
-- (PATCH-1 quota gating + PATCH-2 external-config library, byte-identical
-- logic) with its version identity realigned so patched builds are
-- distinguishable from vendor builds everywhere:
--   * payload header comment  /* Bee.Hive Panel · DCVERSION:3.1.14 */
--   * embedded panel config   VERSION = "3.1.14"  (vendor bundle still said 3.1.12)
--   * bundle line-0 header    DCVERSION:3.1.14
-- sha256 of panel/beehive-panel-3.1.14.js:
--   d825b8f1e8e8f3789f4d536f687a5dc309b6cd771fc0f0a93838ac5cfe016207
-- Reproduce it deterministically:
--   node scripts/patch-panel-bundle.mjs bump-version \
--     --base panel/beehive-panel-3.1.13.js --to 3.1.14 --out panel/beehive-panel-3.1.14.js
-- Re-upload the artifact to R2 before announcing the version:
--   node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.14.js
--
-- Release changelog: every approved version row now carries `changelog_fa` —
-- the Persian "what changed vs the previous release" bullets the Telegram bot
-- renders in update notices, update confirmations and update-completion
-- messages (one change per line, rendered as a bullet list). The bot omits the
-- block when the column is NULL, so older rows need no backfill.

ALTER TABLE panel_versions ADD COLUMN changelog_fa TEXT;

INSERT INTO panel_versions
  (version, artifact_key, artifact_sha256, compatibility_date, notes, changelog_fa, is_active, created_at)
VALUES
  ('3.1.14',
   'panel/beehive-panel-3.1.14.js',
   'd825b8f1e8e8f3789f4d536f687a5dc309b6cd771fc0f0a93838ac5cfe016207',
   '2025-03-10',
   'BEEHIVE release build: PATCH-1/2 logic identical to the approved patched 3.1.13 artifact; version identity realigned to 3.1.14 (payload DCVERSION, embedded VERSION constant, bundle header) so BEEHIVE builds are distinguishable from vendor builds. Bot-facing changelog in changelog_fa.',
   'کانفیگ‌های اکسترنال (External Raw Configs) پس از پایان زمان یا حجم کاربر دیگر در اشتراک ارسال نمی‌شوند و کلاینت آن‌ها را در به‌روزرسانی بعدی حذف می‌کند.
کتابخانهٔ کانفیگ اکسترنال: اعمال یک‌جای کانفیگ‌ها روی کاربران انتخاب‌شده یا گروه‌بندی‌شده (افزودنی یا جایگزینی) از بخش کاربران پنل.
کلید «افزودن خودکار به اشتراک»: کانفیگ‌های کتابخانه به‌صورت خودکار در اشتراک متنی همهٔ کاربران فعال و داخل سهمیه ادغام می‌شود.
کش سمت Worker برای کانفیگ‌های اکسترنال (به‌روزرسانی هر ۶ ساعت) برای پاسخ سریع‌تر اشتراک‌ها.
هم‌راستاسازی شمارهٔ نسخهٔ داخلی پنل: پنل پس از به‌روزرسانی خودش را «3.1.14» معرفی می‌کند و تشخیص بیلد رسمی از بیلد فروشنده ساده‌تر می‌شود.',
   1, 0)
ON CONFLICT (version) DO UPDATE SET
  artifact_key = excluded.artifact_key,
  artifact_sha256 = excluded.artifact_sha256,
  compatibility_date = excluded.compatibility_date,
  notes = excluded.notes,
  changelog_fa = excluded.changelog_fa,
  is_active = excluded.is_active;
