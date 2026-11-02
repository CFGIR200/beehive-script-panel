# BEE.HIVE BOT

Multi-tenant SaaS control plane for **Bee.Hive panels**, built as a single Cloudflare Worker in TypeScript.

A customer talks to a Telegram bot (Persian, RTL). The bot hands them a one-time HTTPS link, the customer
pastes their own Cloudflare API token **into the browser page — never into the chat**, and the bot then
provisions a complete Bee.Hive panel on the customer's own Cloudflare account: D1 database, Worker, cron
trigger, `workers.dev` route and health verification. From then on the customer can update, redeploy, back up,
restore, health-check and delete the panel from Telegram, while an admin dashboard (web) and bot admin panel
show every tenant, job and audit entry.

```
Telegram ──▶ Worker (this repo) ──▶ Cloudflare API (customer account)
                  │                     ├── D1 database  (panel data)
                  │                     ├── Worker       (panel bundle)
                  │                     └── cron trigger (0 * * * *)
                  ├── D1  bot database  (users, accounts, panels, jobs, audit)
                  ├── KV  cache / rate limits
                  └── R2  panel artifact + D1 backups
```

## Status

| Item | State |
|---|---|
| Version | `1.0.0` |
| Panel bundle | `3.1.13`, SHA-256 `b763b2f8…5796eab4` (audited — `docs/INITIAL_AUDIT.md`) |
| Type check | `tsc --noEmit` clean |
| Tests | **94 passing** in 9 files (unit, integration, security, e2e) |
| Bundle | 364.07 KiB, 76.67 KiB gzip (`wrangler 4.86.0 deploy --dry-run`) |
| Production accounts touched | none — no real Cloudflare or Telegram call is made by the test suite |

## Quick start

```bash
npm install --no-audit --no-fund
npm run typecheck          # tsc --noEmit
npm test                   # vitest run  → 94 passed

npx wrangler d1 create beehive_bot            # copy database_id into wrangler.toml
npx wrangler kv namespace create BEEHIVE_CACHE
npx wrangler r2 bucket create beehive-artifacts

# secrets (see docs/DEPLOYMENT.md for generation commands)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY      # base64, exactly 32 bytes
npx wrangler secret put SESSION_SIGNING_KEY

npm run db:migrate:remote
node scripts/upload-panel-artifact.mjs --file panel/beehive-panel-3.1.13.js
npm run deploy
node scripts/set-webhook.mjs --url "$PUBLIC_BASE_URL" --secret "$TELEGRAM_WEBHOOK_SECRET"
curl -s "$PUBLIC_BASE_URL/health"
```

Full order of operations, including the operator smoke test: **`docs/DEPLOYMENT_CHECKLIST.md`**.

## Feature map

**Customer (Telegram, Persian/RTL)** — `/start`, `/id`, `/help`; connect Cloudflare via one-time link;
account picker; install panel; list panels; health; update / redeploy; backup / restore; two-step delete;
recovery-key reveal; subscription status; support contact.

**Provisioning engine** — job rows in D1 with an immutable step plan, lease-based single-writer execution
(`locked_until`), resumable across Worker invocations (webhook `waitUntil` + `* * * * *` cron with a
`JOB_SLICE_MS` budget), per-step timeouts, retry with backoff only for transient Cloudflare failures,
deterministic rollback that deletes **only** resources the job created and recorded. States:
`pending → planning → running → {completed | failed | rollback_required → rolled_back | cancelled}`.

**Subscriptions** — `free`, `basic`, `pro`, `enterprise` seeded in `subscription_plans`; every limit is read
from the database at runtime (`-1` = unlimited). One active subscription per user, history kept, expiry falls
back to the default plan. Install/update/backup/custom-domain flags and panel/account/concurrency caps are
enforced before a job is queued.

**Security** — AES-256-GCM with AAD `beehive:v1:<purpose>:<userId>:<accountRef>` and `keyVersion` rotation;
webhook secret token verified in constant time; update dedupe; D1-backed rate limiting; tenant-scoped SQL;
CSRF-protected dashboard forms; one-time 6-digit Telegram login codes for staff only; `HttpOnly; Secure;
SameSite=Lax` session cookies; redacting logger; tokens never appear in URLs, logs or messages.

**Admin** — bot admin panel (stats, users, plans, jobs, infrastructure, settings, broadcast) and a web
dashboard at `/dashboard` with overview, users, panels, jobs, plans, audit and settings pages plus
`/api/dashboard/{summary,jobs}` for polling.

## Repository layout

```
src/
  index.ts app.ts              Worker entry, router, scheduled handler
  config/                      typed env access + constants
  utils/                       errors, logger/redaction, ids, time, http helpers
  security/                    crypto (AES-GCM, HMAC), validation, rate limiting
  database/                    D1 access + repositories (users, accounts, panels,
                               jobs, settings, subscriptions, audit, links, pending)
  cloudflare/                  API client, accounts, workers, d1, permissions
  auth/                        Cloudflare token flow, Telegram login codes, sessions
  bot/                         Telegram client, router, handlers, admin, keyboards, Persian copy
  provisioning/                planner, steps, executor, rollback, engine, progress
  panels/                      artifact loading/verification, manager, health checks
  subscriptions/limits.ts      plan enforcement
  web/                         landing/status pages, connect page, dashboard, layout
  admin/broadcast.ts           rate-limited broadcast
migrations/                    0001_init (22 tables) … 0004_web_flows (+2 tables)
panel/                         vendored panel bundle (SHA-256 pinned)
tests/                         unit / integration / security / e2e + fixtures & CF API mock
scripts/                       set-webhook.mjs, upload-panel-artifact.mjs, build-release.mjs
docs/                          see the index below
```

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/telegram/webhook` | Telegram updates (secret-token authenticated) |
| `GET`/`POST` | `/connect/:token` | One-time Cloudflare token page |
| `POST` | `/connect/pick` | Sealed account picker (multi-account tokens) |
| `GET` | `/dashboard/login` | Code request page |
| `POST` | `/dashboard/login` \| `/verify` \| `/logout` \| `/action` | Dashboard auth + mutations (CSRF) |
| `GET` | `/dashboard` | Admin dashboard (staff session cookie) |
| `GET` | `/api/dashboard/summary` \| `/jobs` | JSON for polling (session cookie) |
| `GET` | `/health` | Liveness + version |
| `GET` | `/` , `/status` | Public landing / status page |
| `POST` | `/admin/set-webhook` | Operator-only webhook registration |

## Documentation

| Doc | Contents |
|---|---|
| [`docs/INITIAL_AUDIT.md`](docs/INITIAL_AUDIT.md) | Audit of the supplied panel bundle + screenshots; what was extracted, what is unknown, risk register |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Components, data model, job engine, provisioning flow, decisions |
| [`docs/INSTALLATION.md`](docs/INSTALLATION.md) | Operator checklist + customer journey + config reference |
| [`docs/INSTALLATION-FA.md`](docs/INSTALLATION-FA.md) | راهنمای نصب قدم به قدم به فارسی (Phase-by-phase deploy guide, Persian) |
| [`docs/INSTALLATION-FA-MANUAL.md`](docs/INSTALLATION-FA-MANUAL.md) | راه‌اندازی دستی: هر مرحله با کلیک در داشبورد + فقط ۳ دستور (Manual, dashboard-first, Persian) |
| [`docs/INSTALLATION-FA-DASHBOARD.md`](docs/INSTALLATION-FA-DASHBOARD.md) | نصب کامل از روی سایت کلادفلر با Workers Builds و GitHub، بدون ترمینال (Zero-terminal, Cloudflare dashboard + GitHub, Persian) |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Step-by-step deployment, secrets, migrations, artifact upload, rollback |
| [`docs/DEPLOYMENT_CHECKLIST.md`](docs/DEPLOYMENT_CHECKLIST.md) | Printable tick-list |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, key management/rotation, token handling, audit |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Cron, monitoring, backup/restore of the bot DB, incidents, scaling |
| [`docs/API.md`](docs/API.md) | Bot API, dashboard API and the Cloudflare endpoints used |
| [`docs/TESTING.md`](docs/TESTING.md) | What the 94 tests prove, bugs they caught, known gaps |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Symptom → cause → fix |
| [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) | v1.0.0 scope and explicit non-goals |

## Configuration

| Kind | Names |
|---|---|
| Required secrets | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, `SESSION_SIGNING_KEY` |
| Optional secret | `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` (rotation window) |
| Bindings | `DB` (D1, required), `CACHE` (KV), `ARTIFACTS` (R2 — required for install/backup) |
| Core vars | `ENVIRONMENT`, `PUBLIC_BASE_URL`, `BOT_USERNAME`, `BOOTSTRAP_ADMIN_TELEGRAM_ID` |
| Panel vars | `PANEL_ARTIFACT_KEY`, `PANEL_ARTIFACT_VERSION`, `PANEL_ARTIFACT_SHA256`, `PANEL_COMPATIBILITY_DATE`, `PANEL_CRON`, `PANEL_VERIFY_ATTEMPTS`, `PANEL_VERIFY_INTERVAL_MS` |
| Behaviour | `JOB_SLICE_MS`, `FEATURE_SELF_SERVE_INSTALL`, `FEATURE_PAYMENTS`, `SUPPORT_CONTACT` |

Runtime-tunable values (install kill-switch, default plan, global concurrency, maintenance message) live in
`system_settings` and are editable from the admin panel without redeploying.

## Dependencies (read before running `npm audit`)

`package.json` has **no `dependencies`** — the Worker bundle is built from `src/` and ships with zero npm
runtime packages. Everything in `devDependencies` is local tooling (test runner, type checker, deploy CLI).

* `npm audit --omit=dev` → **0 vulnerabilities** (this is what actually reaches production).
* `npm audit` → 13 advisories, all inside the dev toolchain (`vitest`/`tinypool`, `miniflare`/`wrangler`,
  `sharp`, `zod`, `undici`, `@fastify/busboy`, `esbuild`). They were reviewed and accepted for a release whose
  tests must run reproducibly; upgrading them is a deliberate migration, not a `--force` flag.
* **Never run `npm audit fix --force` here.** It upgrades `@cloudflare/vitest-pool-workers` to `0.23.x`, a
  renamed package (`@cloudflare/vitest-plugin`) that needs `vitest ^4` and no longer exports `./config`, so
  `npm test` dies with `Missing "./config" specifier`. Versions are pinned exactly for this reason, and a
  `pretest` guard (`scripts/check-toolchain.mjs`, `npm run doctor`) catches drift with a readable message.

## Explicit non-goals in v1.0.0

No payment provider is integrated (`FEATURE_PAYMENTS=false`, `payments` is a manual ledger). The bot has no
free-text support ticket form (support is a Telegram contact). Custom panel domains, panel admin-password
automation and a Queues consumer are not wired up. Details and rationale: `docs/RELEASE_NOTES.md`.

## License

UNLICENSED — proprietary. Panel bundle © its original author; vendored for deployment only.
