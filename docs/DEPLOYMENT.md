# DEPLOYMENT — BEE.HIVE BOT v1.0.0

Everything below runs from the project root. Nothing in this file contains a secret value.

---

## 0. Prerequisites

| Requirement | Why |
|---|---|
| Cloudflare account **with Workers Paid** | The bot itself fits the free plan, but a 2.9 MB gzipped panel bundle exceeds the 3 MB free script budget on the *customer* accounts you will serve. |
| Node.js ≥ 20 | Wrangler + tests |
| `wrangler` (installed by `npm install`) | deploy, D1, R2 |
| A Telegram bot token from [@BotFather](https://t.me/BotFather) | product interface |
| R2 enabled on the account | panel artifact + D1 backups |

---

## 1. Install dependencies and verify the build

```bash
npm install
npm run typecheck      # must be clean
npm test               # 94 tests, all green
npm run build          # wrangler dry-run bundle
```

## 2. Create the platform resources

```bash
# 2.1 Bot database
npx wrangler d1 create beehive_bot
#    → copy the returned database_id into wrangler.toml ([d1_databases] database_id)

# 2.2 Cache namespace
npx wrangler kv namespace create BEEHIVE_CACHE
#    → copy the id into wrangler.toml ([kv_namespaces] id)

# 2.3 Artifact bucket (panel bundle + D1 backups)
npx wrangler r2 bucket create beehive-artifacts
```

## 3. Edit `wrangler.toml`

Replace every `<PLACEHOLDER>`:

```toml
PUBLIC_BASE_URL = "https://beehive-bot.<your-subdomain>.workers.dev"
BOT_USERNAME = "your_bot_username_without_at"
BOOTSTRAP_ADMIN_TELEGRAM_ID = "123456789"   # your own Telegram id (send /start then /id to the bot)
```

`PANEL_ARTIFACT_SHA256` is pre-set to the audited bundle digest
(`7381d693589a7699496d8ca86f6fc020199bb7e092d81b02d54d72f0f8919bc0` — BEEHIVE-PATCH-1 build, see
`docs/PATCH-EXTERNAL-CONFIGS.md`). Change it **only** when you deliberately
ship a different panel build, and update `migrations/0002_seed_plans.sql` in the same commit.

## 4. Set the five secrets

Generate strong values first (macOS/Linux):

```bash
openssl rand -base64 32     # CREDENTIAL_ENCRYPTION_KEY   (must be exactly 32 bytes when base64-decoded)
openssl rand -base64 32     # SESSION_SIGNING_KEY
openssl rand -hex 24        # TELEGRAM_WEBHOOK_SECRET
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN            # from BotFather, e.g. 123456:ABC-DEF…
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET       # the hex string above
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY     # base64 of exactly 32 random bytes
npx wrangler secret put SESSION_SIGNING_KEY           # base64/hex of ≥32 random bytes
```

Optional (recommended once a rotation window is planned):

```bash
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
```

> **Keep `CREDENTIAL_ENCRYPTION_KEY` outside the repository.** If it is lost, every stored Cloudflare token
> must be re-entered by the customer (panels keep running; only management is lost).

## 5. Apply the migrations

```bash
npm run db:migrate:remote
# equivalently: npx wrangler d1 migrations apply beehive_bot --remote
```

Four migrations are applied: `0001_init` (schema), `0002_seed_plans` (plans + approved panel version),
`0003_seed_settings` (runtime settings), `0004_web_flows` (pending connections + dashboard codes).

Verify:

```bash
npx wrangler d1 execute beehive_bot --remote --command \
  "SELECT code, max_panels, allow_backup FROM subscription_plans ORDER BY sort_order"
```

## 6. Upload the panel artifact

```bash
node scripts/upload-panel-artifact.mjs \
  --file panel/beehive-panel-3.1.13.js \
  --key  panel/beehive-panel-3.1.13.js \
  --bucket beehive-artifacts
```

The script prints the real size, gzip size and SHA-256. It must equal `PANEL_ARTIFACT_SHA256`, otherwise the
installer will refuse to deploy (by design).

## 7. Deploy the Worker

```bash
npm run deploy
```

Note the deployed URL. If it differs from `PUBLIC_BASE_URL`, fix `wrangler.toml` and redeploy — the connect
links are absolute URLs.

## 8. Register the Telegram webhook

```bash
node scripts/set-webhook.mjs --url https://beehive-bot.<sub>.workers.dev --secret <TELEGRAM_WEBHOOK_SECRET>
```

Expected: `{"ok":true,"url":"…/telegram/webhook","info":{…}}`.

## 9. First-run checks

```bash
curl -s https://beehive-bot.<sub>.workers.dev/health
# {"ok":true,"version":"1.0.0","time":…}
```

1. Open the bot in Telegram → `/start`.
2. Send `/id` and confirm the id matches `BOOTSTRAP_ADMIN_TELEGRAM_ID`.
3. Wait for the next cron tick (≤ 60 s) — the bootstrap admin is promoted once.
   Verify: `npx wrangler d1 execute beehive_bot --remote --command "SELECT * FROM user_roles WHERE role='super_admin'"`
4. Open `https://…/dashboard/login`, enter your Telegram id, receive the 6-digit code in Telegram, sign in.
5. In the bot: «اتصال Cloudflare» → follow the token link → paste the token on the connect page → pick the
   account → the bot confirms the connection.
6. «ساخت پنل جدید» → choose the account → send a worker name (or press «نام خودکار») → watch the progress
   message until the panel URL and recovery key appear.

## 10. Post-deployment hygiene

* Do **not** keep `wrangler.toml` `BOOTSTRAP_ADMIN_TELEGRAM_ID` pointing at a non-admin once promotion has
  happened (it only acts while no `super_admin` exists, so it is harmless, but tidy).
* Set `SUPPORT_CONTACT` to a real channel.
* Review `system_settings.install_enabled`, `max_global_concurrency` (default 6) and `default_plan`.
* Take a backup of the bot database weekly: `npx wrangler d1 export beehive_bot --remote --output bot-backup.sql`.

---

## Rollback of a deployment

```bash
# revert the Worker to the previous version
npx wrangler rollback
# if a migration must be undone, restore the bot database from an export:
npx wrangler d1 execute beehive_bot --remote --file bot-backup.sql
```

Customer panels are untouched by a bot rollback: they are independent Workers on customer accounts.
