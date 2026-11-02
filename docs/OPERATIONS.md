# OPERATIONS — BEE.HIVE BOT v1.0.0

## 1. What runs when

| Trigger | Work |
|---|---|
| `POST /telegram/webhook` (every update) | authenticate, route to a handler, `waitUntil(drain(≤20 s))` |
| Cron `* * * * *` | promote bootstrap admin → `drain(jobSliceMs)` → housekeeping (subscription expiry, sessions, rate-limit buckets, backups, idempotency keys, webhook events, audit retention) → mark stale `provisioning` panels failed |
| Dashboard/bot refresh | re-render job progress from D1 |
| Customer action | create/advance jobs |

## 2. Monitoring

| Signal | Where | Healthy |
|---|---|---|
| Liveness | `GET /health` | `{"ok":true}`, HTTP 200 |
| Panel fleet | dashboard → Overview (`panelStatus`, `jobStatus`) | `failed` + `rollback_required` ≈ 0 |
| Job throughput | dashboard → Jobs, and Workers Logs (`msg:"jobs advanced"`) | jobs move within 1–2 minutes |
| Errors | dashboard → Audit (`severity=error`) | no spike |
| Cloudflare API health | Workers Logs: `code:"CF_UNAVAILABLE"`, `CF_RATE_LIMITED` | occasional retries only |
| D1 quota | Cloudflare dashboard → D1 → metrics (panel errors surface as `سهیمهٔ دیتابیس D1 پر شده است` inside the panel itself) | under daily limit |
| Telegram rate limits | Logs: `webhook.rate_limited` | rare |

Add an uptime monitor on `https://<worker>/health` (Cloudflare Health Checks or any external monitor).

## 3. Routine tasks

### 3.1 Backups

```bash
# bot database (weekly)
npx wrangler d1 export beehive_bot --remote --output "backup-$(date +%F).sql"
```

Customer panel backups are taken per panel from the bot («پشتیبان‌گیری») and stored in R2 under
`backups/<panelUid>/<jobId>.sql` with a 30-day expiry (a cron pass removes expired rows; prune the R2 objects
with `npx wrangler r2 object delete beehive-artifacts/backups/...` in a monthly job).

### 3.2 Restoring the bot database

```bash
npx wrangler d1 execute beehive_bot --remote --file backup-2026-11-01.sql
npx wrangler deploy      # redeploy so any schema-dependent code is reloaded
```

Stored Cloudflare tokens survive the restore only if `CREDENTIAL_ENCRYPTION_KEY` is unchanged.

### 3.3 Publishing a new panel version

1. Put the new bundle in `panel/`.
2. `node scripts/upload-panel-artifact.mjs --file panel/<new>.js --key panel/<new>.js`
3. Insert/activate the version:

```sql
INSERT INTO panel_versions (version, artifact_key, artifact_sha256, compatibility_date, notes, is_active, created_at)
VALUES ('3.2.0', 'panel/<new>.js', '<sha256>', '2025-03-10', 'release notes', 1, unixepoch()*1000);
UPDATE panel_versions SET is_active = 0 WHERE version = '3.1.13';
```

4. Update `PANEL_ARTIFACT_VERSION` / `PANEL_ARTIFACT_SHA256` / `PANEL_ARTIFACT_KEY` in `wrangler.toml`,
   `npx wrangler deploy`.
5. Customers see «به‌روزرسانی» become available; updates reuse the same D1 database (no data loss).

**Kill switch:** `UPDATE panel_versions SET is_active = 0` ⇒ the installer and updater refuse that version
immediately (`ARTIFACT_MISSING`), before any Cloudflare call.

### 3.4 Advancing a stuck job

```bash
# find it
npx wrangler d1 execute beehive_bot --remote --command \
 "SELECT id, kind, status, current_step, attempt, error_code FROM deployment_jobs WHERE status NOT IN ('completed','failed','cancelled','rolled_back')"
# clear the lease so the next cron tick retries immediately
npx wrangler d1 execute beehive_bot --remote --command \
 "UPDATE deployment_jobs SET locked_until = 0, lease_owner = NULL WHERE id = '<id>'"
```

### 3.5 Plan changes

Bot: `/admin` → «پلن‌ها» → a plan → change limit/price.
Dashboard: `?page=plans` → edit fields → save.
Both write `plan.updated` to the audit log.

## 4. Cost model

| Resource | Driver | Notes |
|---|---|---|
| Worker requests | Telegram updates + dashboard + cron (1/min) | cron alone is ~43k requests/month |
| D1 rows read/written | a few dozen per update, ~10 per job step | bot DB stays small (thousands of rows) |
| R2 storage | one panel artifact (~9 MB raw) + per-panel D1 dumps | backups expire after 30 days |
| Customer Cloudflare account | the panel's own Workers requests, D1 storage, egress | the customer pays; the panel prompts when the D1 daily quota is exhausted |
| Workers Paid | required for customer accounts deploying a 2.9 MB gzipped script | see DEPLOYMENT.md §0 |

## 5. Capacity tuning

| Setting | Default | Effect |
|---|---|---|
| `system_settings.max_global_concurrency` | 6 | simultaneous jobs across all customers |
| `JOB_SLICE_MS` | 22000 | wall-clock budget per invocation |
| plan `max_concurrent_jobs` | 1–4 | per-customer concurrency |
| `HARD_LIMITS.maxPanelsPerUser` | 20 | absolute ceiling regardless of plan |
| `RATE_LIMITS.updatesPerMinute` | 40 | per-user command rate |

## 6. On-call runbook (top 5 alarms)

1. **`/health` non-200** → `npx wrangler tail` and check `not ready`/`configuration error` lines; verify the
   five secrets exist (`npx wrangler secret list`).
2. **Jobs piling in `pending`** → check the cron trigger exists (`npx wrangler deployments list`), then the
   global concurrency cap, then the lease clearing procedure (§3.4).
3. **`CF_FORBIDDEN` spike** → customers reconnected tokens with the wrong scopes; the connect page shows the
   exact missing scope; no code change needed.
4. **`CF_RATE_LIMITED` spike** → lower `max_global_concurrency` and re-check job flow.
5. **Telegram 401/403** → bot token revoked or the user blocked the bot; rotate the token, re-run
   `scripts/set-webhook.mjs`.
