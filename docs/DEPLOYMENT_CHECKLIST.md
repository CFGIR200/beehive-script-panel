# Deployment checklist — BEE.HIVE BOT v1.0.0

Print this and tick every box. A deployment is not "done" until all items are checked.

## 1. Prerequisites

- [ ] Cloudflare account with **Workers Paid** (required for customer panels — 2.9 MB gzipped bundle)
- [ ] Node.js ≥ 20 installed
- [ ] Telegram bot created with @BotFather; token in hand
- [ ] Telegram numeric id of the operator (`/id` in the bot after first deploy, or from @userinfobot)
- [ ] R2 enabled on the account

## 2. Build verification

- [ ] `npm install --no-audit --no-fund` completed (never `npm audit fix --force`)
- [ ] `npm run doctor` silent
- [ ] `npm run typecheck` — **0 errors**
- [ ] `npm test` — **94 passed**
- [ ] `npm run build` — dry-run succeeds (364.07 KiB / 76.67 KiB gzip)

## 3. Platform resources

- [ ] `npx wrangler d1 create beehive_bot` → `database_id` copied into `wrangler.toml`
- [ ] `npx wrangler kv namespace create BEEHIVE_CACHE` → `id` copied into `wrangler.toml`
- [ ] `npx wrangler r2 bucket create beehive-artifacts`

## 4. `wrangler.toml`

- [ ] `PUBLIC_BASE_URL` = the final HTTPS origin (no trailing slash)
- [ ] `BOT_USERNAME` = bot username without `@`
- [ ] `BOOTSTRAP_ADMIN_TELEGRAM_ID` = operator Telegram id
- [ ] `PANEL_ARTIFACT_KEY` / `PANEL_ARTIFACT_VERSION` / `PANEL_ARTIFACT_SHA256` match the artifact you uploaded
- [ ] `PANEL_CRON` = `0 * * * *` (panel housekeeping)
- [ ] No remaining `<PLACEHOLDER>` in the file (`grep PLACEHOLDER wrangler.toml` → empty)
- [ ] `[triggers] crons = ["* * * * *"]` present (job executor)

## 5. Secrets (exactly these four required)

- [ ] `TELEGRAM_BOT_TOKEN`
- [ ] `TELEGRAM_WEBHOOK_SECRET` (≥ 16 chars, random)
- [ ] `CREDENTIAL_ENCRYPTION_KEY` (**base64 of exactly 32 bytes**)
- [ ] `SESSION_SIGNING_KEY` (≥ 32 random bytes)
- [ ] `npx wrangler secret list` shows all four
- [ ] Keys stored in a password manager **outside** the repository

## 6. Database

- [ ] `npm run db:migrate:remote` — 4 migrations applied, no error
- [ ] `SELECT COUNT(*) FROM subscription_plans` → **4**
- [ ] `SELECT version, artifact_sha256, is_active FROM panel_versions` → `3.1.13`, matching digest, `1`
- [ ] `SELECT COUNT(*) FROM system_settings` → **8**

## 7. Panel artifact

- [ ] `node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js`
- [ ] Printed SHA-256 = `7381d693589a7699496d8ca86f6fc020199bb7e092d81b02d54d72f0f8919bc0`
- [ ] `npx wrangler r2 object get beehive-artifacts/panel/beehive-panel-3.1.13.js --file /tmp/check.js` succeeds and `/tmp/check.js` is 9,044,381 bytes

## 8. Deploy

- [ ] `npm run deploy` succeeded; URL recorded
- [ ] URL equals `PUBLIC_BASE_URL` (otherwise fix and redeploy)
- [ ] `node scripts/set-webhook.mjs --url <URL> --secret <TELEGRAM_WEBHOOK_SECRET>` → `{"ok":true,…}`
- [ ] `curl -s <URL>/health` → `{"ok":true,"version":"1.0.0",…}`
- [ ] `curl -sI <URL>/connect/anything` → 404 and `X-Frame-Options: DENY`

## 9. Functional smoke test (real account, minimal resources)

Perform on a **dedicated test Cloudflare account** first.

- [ ] `/start` in the bot → welcome + menu
- [ ] `/id` → matches the bootstrap id
- [ ] After ≤ 60 s: `SELECT role FROM user_roles WHERE role='super_admin'` → one row
- [ ] «اتصال Cloudflare» → token page opens with the three scopes preselected
- [ ] Connect page accepts the token; bot reports the account as connected with permissions OK
- [ ] `SELECT ciphertext FROM encrypted_credentials WHERE id=1` does **not** contain the token
- [ ] «ساخت پنل جدید» → account → name → progress message walks through the 8 steps
- [ ] Final message contains the panel URL, D1 name, version and recovery key
- [ ] The panel URL opens and shows the Bee.Hive login/setup page
- [ ] `SELECT status FROM panels` → `active`
- [ ] «بررسی سلامت» → healthy
- [ ] «به‌روزرسانی / نصب مجدد» → completes, data preserved
- [ ] «پشتیبان‌گیری» (Pro plan or granted) → backup id returned; object exists in R2
- [ ] «حذف پنل» → confirmation → completes; Worker and D1 removed in the Cloudflare dashboard
- [ ] Dashboard login at `/dashboard/login` → code arrives in Telegram → overview renders

## 10. Hardening before opening to customers

- [ ] WAF rate-limit rule on `/connect/*` and `/dashboard/login`
- [ ] Uptime monitor on `/health`
- [ ] `system_settings.install_enabled` set deliberately; `default_plan` set deliberately
- [ ] `max_global_concurrency` reviewed against Cloudflare API quotas
- [ ] Plan limits/prices reviewed in `/admin` → پلن‌ها
- [ ] `SUPPORT_CONTACT` points at a staffed channel
- [ ] Bot database export schedule agreed (`wrangler d1 export` weekly)
- [ ] Incident runbook shared with the on-call engineer (`docs/OPERATIONS.md` §6)
- [ ] `CREDENTIAL_ENCRYPTION_KEY` rotation procedure rehearsed once (`docs/SECURITY.md` §2)

## 11. Sign-off

- [ ] Deployed by: ______________________  date: __________
- [ ] Panel bundle version deployed: `3.1.13` (SHA-256 verified)
- [ ] All tests green on the released commit
- [ ] Residual limitations acknowledged: no payments, no user ticket form, no custom domains,
      no queue consumer (`docs/RELEASE_NOTES.md`)
