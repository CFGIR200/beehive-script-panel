# Release notes — BEE.HIVE BOT v1.0.0

Release date: 2026-11-01
Artifact: `BEEHIVE-BOT-PRODUCTION-v1.0.0.zip`

## What this release is

A production-oriented SaaS control plane, deployed as a single Cloudflare Worker, that lets Telegram users
connect their own Cloudflare account and install, monitor, update, back up and delete **Bee.Hive Panels**
(panel bundle `3.1.13`, audited — see `docs/INITIAL_AUDIT.md`).

## Highlights

### Cloudflare connection
* One-time, single-use connect link (40-char token, SHA-256 at rest, 15-minute TTL, per-IP rate limit).
* The API token is entered **only** on an HTTPS page — never in the Telegram chat (the reference flow shown
  in the screenshots does the opposite, deliberately not copied).
* Token verified with `/user/tokens/verify`, accounts discovered via `/accounts`, and the three required
  scopes probed (`Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read`).
* Sealed with AES-256-GCM bound to `user:account:purpose`; key rotation supported; disconnect wipes the
  ciphertext.
* Two-step account picker for tokens that can see several accounts (sealed handle, 10-minute TTL).

### Provisioning engine
* Eight-step, resumable install: validate → subdomain → D1 → upload → workers.dev → cron → verify → finalize.
* Job store in D1 with an immutable step plan, lease-based single-writer execution, per-step timeouts, retry
  with backoff for transient Cloudflare failures, deterministic rollback for the rest.
* Rollback deletes **only** resources the job created and recorded, verified by external id.
* Progress is reported by editing one Telegram message per job.

### Panel management
* List, detail, health check (marker assertion against the panel's own HTML), recovery-key reveal (audited),
  update, redeploy, two-step delete, backup and restore.
* Backup via the documented D1 export API → R2 with checksum and 30-day expiry; restore via the documented
  D1 import API (init → upload → ingest → poll).
* Version registry with an instant kill-switch (`panel_versions.is_active`).

### Bot (Persian, RTL)
* Inline + reply keyboards, pagination, confirmations for destructive actions, session state with TTL,
  duplicate-click protection, human error messages, trace ids for support.

### Admin
* Bot admin panel (dashboard stats, user search/card, block/unblock, plan grants, plan limit/price editing,
  jobs list, infrastructure view, settings toggles, broadcast with confirmation).
* Web dashboard (`/dashboard`) with Telegram one-time-code login, session cookies, CSRF, pages for overview,
  users, panels, jobs, plans, audit and settings, plus JSON endpoints for polling.

### Subscriptions
* Four seeded plans (`free`, `basic`, `pro`, `enterprise`); every limit lives in `subscription_plans` and is
  read at runtime (panels, accounts, concurrency, update, backup, custom-domain flag, backup byte cap).

### Security
* Webhook secret token (constant-time), update dedupe, D1 rate limiting, CSRF, tenant-scoped SQL, redacting
  logger, secret-free error messages, one-time codes, `HttpOnly; Secure; SameSite=Lax` sessions.

## Database
* `0001_init` — 22 tables, foreign keys, indexes, partial unique index for one active subscription per user.
* `0002_seed_plans` — 4 plans and the approved panel version (SHA-256 pinned).
* `0003_seed_settings` — runtime settings.
* `0004_web_flows` — pending connections and dashboard login codes (24 tables total).

## Tests
94 automated tests across 9 files (unit, integration, security, e2e) running in the real Workers runtime.
Five defects found by the suite were fixed before release (see `docs/TESTING.md`).

## Explicitly not included (do not assume they exist)

1. **Payment gateway.** `FEATURE_PAYMENTS=false`; the `payments` table is a manual ledger only. No callback
   or webhook for a provider is implemented.
2. **User-facing support ticket form.** The table and admin views exist; in the bot, support is a Telegram
   contact (`SUPPORT_CONTACT`).
3. **Custom domains for panels.** The plan flag exists; attaching hostnames needs zone permissions the token
   deliberately does not request.
4. **Cloudflare Queues.** Jobs run on a D1-backed resumable executor; `drain()` is queue-consumer ready but no
   queue consumer is wired.
5. **Panel password automation.** The bot does not set the panel's admin password; the panel claims itself on
   first visit (its own design).
6. **Real-account integration tests.** The Cloudflare API is mocked in tests; live verification is the
   operator checklist in `docs/DEPLOYMENT.md`.

## Toolchain (v1.0.0 shipped pins)

`wrangler 4.86.0`, `@cloudflare/workers-types 4.20260702.1`, `typescript 5.6.3`, `vitest 2.1.8`,
`@cloudflare/vitest-pool-workers 0.6.3` — all exact, enforced by the `pretest` guard. Verified with this set:
`tsc --noEmit` clean, 94/94 tests, `wrangler deploy --dry-run` 364.07 KiB / 76.67 KiB gzip.
`npm audit --omit=dev` → 0 vulnerabilities; the Worker has no npm runtime dependencies.

## Upgrade / compatibility

* Fresh deployment: follow `docs/DEPLOYMENT.md`.
* Panel compatibility: bundle `3.1.13` (internal `VERSION` constant reads `3.1.12` — see audit §4). Requires
  a D1 binding named `DB`; no KV/R2/Queues on the customer side.
* Cloudflare API surface used is limited to Workers Scripts, D1 and Account Settings, as documented in
  `docs/API.md`.

## Known constraints

* The panel bundle is 2.9 MB gzipped → customer accounts need Workers **Paid** to host it.
* `workers.dev` verification can take a few seconds to propagate; the verifier retries with backoff.
* D1 export/import are asynchronous and can be slow on large databases; both are job-based with polling
  budgets and clear failure messages.

## Post-release increments (2026-11-13/14)

* **PATCH-1** — external raw configs stop being served to users whose time/traffic quota is exhausted
  (bundle-level change; see `docs/PATCH-EXTERNAL-CONFIGS.md`).
* **PATCH-2** — external-config library: bulk-apply configs to users and an auto-include switch that adds
  them to every active subscription's user panel (migration `0006`).
* **UPDNOTIFY-1** — cron-driven Telegram update notices with a one-tap update button, plus the
  patch-retention pipeline (`scripts/patch-panel-bundle.mjs`, migration `0007`).
* **UPDALL-1** — "update all opened panels" straight from the bot: user-level and admin-level bulk update
  (`startUpdateBatch`), optional cron auto-apply (`update_auto_apply`, migration `0008`). Tests: 112 across
  11 files, `tsc --noEmit` clean. See `docs/UPDATES.md` §4.
* **UPDDIGEST-1** — build-level currency: "up to date" now requires BOTH the version string and the
  recorded `panels.artifact_sha256` build digest to match the approved artifact. The patched BEEHIVE
  bundle and the original vendor bundle both report version `3.1.13`, so version-only comparison made
  panels running the unpatched build permanently "current" — pressing "به‌روزرسانی" answered "already on
  3.1.13" and the patches never arrived. Affected panels are now flagged outdated exactly once and
  converge to the patched build via the Telegram notice, the "به‌روزرسانی همه" button, or the
  `update_auto_apply` cron; the update screen shows a dedicated "stale build" note for them. The cron
  refuses to notify when `PANEL_ARTIFACT_SHA256` disagrees with the `panel_versions` registry (half-applied
  release guard). Tests: 116 across 11 files, `tsc --noEmit` clean. See `docs/UPDATES.md` §1.
