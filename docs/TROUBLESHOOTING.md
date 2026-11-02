# TROUBLESHOOTING — BEE.HIVE BOT v1.0.0

Every entry is a real failure mode of *this* codebase; the fix column points at the exact mechanism.

## Install / toolchain (npm)

| Symptom | Cause | Fix |
|---|---|---|
| `npm test` dies with `✘ [ERROR] Missing "./config" specifier in "@cloudflare/vitest-pool-workers" package` | `npm audit fix --force` upgraded the test runner to `0.23.x` — that release was **renamed** to `@cloudflare/vitest-plugin`, needs `vitest ^4`, and dropped the `./config` export | delete `node_modules` **and** `package-lock.json`, then `npm install --no-audit --no-fund` (restores the pinned `0.6.3` / `vitest 2.1.8` that the 94 tests were verified on) |
| `npm error ERESOLVE … peer vitest@"^4.1.0" from @cloudflare/vitest-pool-workers@0.23.0` | same forced upgrade left a half-migrated tree | same fix as above; do not add `--force` or `--legacy-peer-deps` |
| `npm audit` reports 13 advisories (3 moderate, 8 high, 2 critical) | all of them live in **dev-only** tooling (`vitest`, `tinypool`, `miniflare`, `wrangler`, `sharp`, `zod`, `undici`, `@fastify/busboy`, `esbuild`) | none of them ship in the Worker: `package.json` has **no** `dependencies`, so `npm audit --omit=dev` prints `found 0 vulnerabilities`. Do **not** run `npm audit fix --force`; it breaks the test suite. Track upgrades deliberately as a separate task. |
| `npm test` prints `✘ Dependency toolchain was modified` | the `pretest` guard noticed a version drift | run the printed fix; the guard exists to turn a cryptic esbuild error into that message |
| `npm warn deprecated wrangler@3.101.0: Downgrade to 3.99.0` | npm deprecation flag on that specific release | harmless for `deploy`/`build` (verified: dry-run 374.30 KiB). If it bothers you, pin `wrangler 3.99.0` and re-run `npm run build`. |

## Boot / configuration

| Symptom | Cause | Fix |
|---|---|---|
| Page says «راه‌اندازی ناقص است» and `/health` returns `{"ok":false,"reason":"not_configured","missing":[…]}` | a required secret is missing | `npx wrangler secret put <NAME>` for each listed name |
| `/health` 500 `invalid_configuration` | `PUBLIC_BASE_URL` is not a valid absolute URL, or not HTTPS in production | fix `[vars] PUBLIC_BASE_URL` in `wrangler.toml`, redeploy |
| Boot error `CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes` | key is not base64 of 32 bytes | `openssl rand -base64 32` and `wrangler secret put` again |
| `D1 binding missing` | `DB` binding absent | add `[[d1_databases]] binding = "DB"`, deploy |

## Telegram

| Symptom | Cause | Fix |
|---|---|---|
| Bot silent, `getWebhookInfo` shows no URL | webhook never registered | `node scripts/set-webhook.mjs --url … --secret …` |
| `getWebhookInfo.last_error_message` = 401 | `TELEGRAM_WEBHOOK_SECRET` mismatch | re-put the secret and re-register the webhook |
| Updates arrive but nothing happens | user blocked, or rate limited | check Audit (`user blocked`, `webhook.rate_limited`) |
| «⛔ دسترسی شما به ربات مسدود شده است» | admin blocked the user | unblock from `/admin` or the dashboard |
| Every message answers «متوجه نشدم» | the update is not text (stickers/photos are unsupported by design) | n/a |
| Admin menu missing | the user has no `admin`/`super_admin` role | `/id` then `INSERT INTO user_roles …`, or wait for the cron bootstrap if `BOOTSTRAP_ADMIN_TELEGRAM_ID` matches |

## Cloudflare connection

| Symptom | Cause | Fix |
|---|---|---|
| «این لینک معتبر نیست یا منقضی شده است» | link > 15 min, already used, or superseded by a newer link | request a new link in the bot |
| «قالب توکن معتبر نیست» | pasted a bot token, an API *key*, or a truncated value | recreate the token; it must be 40–64 chars of `A-z0-9_-` |
| «توکن نامعتبر یا منقضی است» | `/user/tokens/verify` returned non-active | create a new token |
| «حسابی پیدا نشد» | token was scoped to a single account/zone and cannot list accounts | recreate with *Include → All accounts* |
| «حساب متصل شد، اما این دسترسی‌ها فعال نیست…» | missing one of the three scopes | recreate the token with the exact three permissions; the page lists which one failed |
| Two-step picker appears | the token can see several accounts | expected; pick one |

## Install / update

| Symptom | Cause | Fix |
|---|---|---|
| `PERMISSION_MISSING` at step 1 | token lacks `Workers Scripts:Edit`, `D1:Edit` or `Account Settings:Read` | reconnect with correct scopes |
| `ARTIFACT_MISSING` | R2 object missing, `panel_versions` row absent, or `is_active = 0` | run `scripts/upload-panel-artifact.mjs`; check `SELECT * FROM panel_versions` |
| `ARTIFACT_INTEGRITY` | uploaded bytes differ from the registered SHA-256 | re-upload the exact approved file; never hand-edit the bundle |
| `CF_ERROR` "Script too large" | the panel bundle (2.9 MB gz) exceeds the customer's plan limit | customer account needs Workers **Paid** |
| `verify_endpoint` fails with `HTTP 200 (marker missing)` | something other than the panel answered (wrong worker name, or a stale worker) | delete and reinstall; check the URL in a browser |
| `verify_endpoint` fails with `timeout` | workers.dev propagation slow | retry: the executor retries automatically (attempt ≤ 3) |
| Job stuck in `pending` | global concurrency cap reached, or a stuck lease | OPERATIONS.md §3.4 |
| «یک عملیات دیگر در حال اجراست» | plan `max_concurrent_jobs` reached | wait, or raise the plan |
| «به سقف پلن خود رسیده‌اید» | `max_panels` reached | grant a bigger plan |
| Worker name rejected | must be lowercase `a-z0-9-`, no leading/trailing/double dash, ≥3 chars | choose another |
| `CONFLICT` "این نام Worker قبلاً استفاده شده است" | name already exists in the account | choose another, or press «نام خودکار» |

## Delete

| Symptom | Cause | Fix |
|---|---|---|
| «منابع ثبت‌شده‌ای برای این پنل پیدا نشد» | the panel row has no `panel_resources` (inserted out-of-band) | delete the Worker/D1 manually in the Cloudflare dashboard, then archive the row |
| `FORBIDDEN` during delete | the tracked resource id no longer matches the panel (tampering or a manual rename) | inspect `panel_resources` before proceeding; this guard exists on purpose |
| Job ends `rollback_required` | a rollback step failed (usually the token lost permission mid-flight) | fix the token, re-run the delete |

## Backup / restore

| Symptom | Cause | Fix |
|---|---|---|
| `ARTIFACT_MISSING` "مخزن فایل (R2) تنظیم نشده است" | no `ARTIFACTS` binding | add `[[r2_buckets]]`, deploy |
| «تهیهٔ پشتیبان زمان‌بر شد» | D1 export took longer than the polling budget | retry; the export is idempotent |
| «بازیابی ناموفق بود» | import rejected (e.g. dump larger than the D1 quota, or a locked database) | verify `d1 import` limits; retry during a quiet window |
| Restore is refused | backup belongs to another panel, is not `completed`, or exceeds the plan byte cap | use a backup from this panel within the plan limit |

## Dashboard

| Symptom | Cause | Fix |
|---|---|---|
| Login page keeps returning to itself | the Telegram id has no staff role | grant `admin`/`support`/`super_admin` |
| «کد نامعتبر یا منقضی است» | > 5 minutes, already used, or 5 wrong attempts | request a new code |
| Actions appear to do nothing | CSRF mismatch (page loaded before a re-login) | reload the page and retry |
| Session dies early | 12 h TTL, or password/role change | log in again |

## Data / database

| Symptom | Cause | Fix |
|---|---|---|
| Panel itself shows «سهیمهٔ دیتابیس D1 پر شده است» | customer's D1 daily quota | that is the panel's own limit (Free plan 5 M rows/day); advise upgrading |
| `SQLITE_CONSTRAINT` on subscriptions | a second active subscription for one user | `subsRepo.grant` cancels the previous one first; do not insert directly |
| Duplicate panels for one worker name | should be impossible (`UNIQUE(cloudflare_account_id, worker_name)`) | report as a bug with the trace id |

## Getting a trace id

Every user-visible failure in the bot shows «شناسهٔ رهگیری» (`tr_…`) or the job id. Both are indexed in
`audit_logs.trace_id` / `deployment_jobs.trace_id`:

```bash
npx wrangler d1 execute beehive_bot --remote --command \
 "SELECT created_at, action, severity, detail FROM audit_logs WHERE trace_id = 'tr_xxx' ORDER BY id"
npx wrangler d1 execute beehive_bot --remote --command \
 "SELECT name, status, message, error_code FROM deployment_steps WHERE job_id = 'xxx' ORDER BY seq"
```

No secret is ever written to `detail` — the logger redacts token-shaped values and sensitive keys before
persisting.
