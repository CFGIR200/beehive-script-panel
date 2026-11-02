# ARCHITECTURE — BEE.HIVE BOT v1.0.0

## 1. System context

```
                     ┌──────────────────────────────┐
                     │        Telegram users        │
                     └───────────────┬──────────────┘
                    webhook (secret) │ one-time HTTPS connect link
                                     ▼
                 ┌───────────────────────────────────────┐
                 │      BEE.HIVE BOT  (this Worker)      │
                 │                                       │
                 │  bot/        handlers + keyboards     │
                 │  auth/       telegram · dashboard ·   │
                 │              cloudflare credentials   │
                 │  provisioning/ planner · executor ·    │
                 │              steps · rollback         │
                 │  panels/     manager · health ·       │
                 │              artifact · backup        │
                 │  subscriptions/ plans · limits        │
                 │  security/   crypto · validation ·    │
                 │              rate-limit · audit       │
                 │  web/        connect page · dashboard  │
                 │  database/   D1 repositories          │
                 └───┬───────────┬───────────┬───────────┘
                     │           │           │
              D1 (own DB)   KV (cache)   R2 (artifacts+backups)
                     │
                     │ Cloudflare API v4 (per-customer token, decrypted per job)
                     ▼
        ┌────────────────────────────────────────────────┐
        │   Customer Cloudflare account                  │
        │   D1 database  +  Worker script (Bee.Hive)     │
        │   + workers.dev route + cron trigger           │
        └────────────────────────────────────────────────┘
```

**Key architectural rule:** the bot is a *control plane*. It never proxies customer traffic; the panel runs
on the customer's account and its data never leaves that account.

## 2. Layer responsibilities

| Layer | Module | Responsibility | Must never do |
|---|---|---|---|
| Edge entry | `src/index.ts`, `src/app.ts` | route HTTP + cron, config validation | contain business rules |
| Interaction | `src/bot/*`, `src/web/*` | Persian UX, keyboards, HTML pages | touch D1 directly |
| Authorisation | `src/auth/*` | webhook secret, one-time codes, session cookies, credential sealing | leak tokens |
| Domain | `src/provisioning/*`, `src/panels/*`, `src/subscriptions/*` | plans, limits, job planning, step execution, rollback, health | call Cloudflare outside `src/cloudflare/*` |
| Integration | `src/cloudflare/*` | one HTTP client, retries, error mapping, endpoints | log the token |
| Persistence | `src/database/*` | parameterised SQL, tenant scoping | build SQL from user input |

## 3. Data model (D1, schema `migrations/0001..0004`)

```
users ─┬─ user_roles (role check: super_admin|admin|support|user)
       ├─ bot_sessions (chat_id PK: conversation state, TTL)
       ├─ cloudflare_accounts ─┬─ encrypted_credentials (AES-256-GCM, AAD=user:account:purpose)
       │                       └─ panels ─┬─ panel_resources (ownership ledger for deletes/rollback)
       │                                  ├─ panel_backups
       │                                  └─ deployment_jobs ── deployment_steps
       ├─ subscriptions ── subscription_plans (all limits live here)
       ├─ payments (ledger only; no provider in v1.0.0)
       ├─ support_tickets
       ├─ connect_links (sha256 of the one-time token)
       ├─ pending_connections (sealed token between connect steps)
       ├─ dashboard_login_codes (one-time dashboard codes)
       └─ admin_sessions (dashboard sessions)

global: audit_logs, system_settings, webhook_events, idempotency_keys, rate_limits, panel_versions
```

Tenant isolation is enforced in SQL, not in JavaScript: every repository function that returns tenant data
takes `userId` and puts it in the `WHERE` clause. The security test suite asserts this for panels, accounts,
credentials, jobs and recovery keys.

## 4. Provisioning engine

### 4.1 State machine

```
pending → validating → provisioning → configuring → deploying → verifying → completed
                                                    │
                                                    ├→ failed  (deterministic error)
                                                    ├→ rolled_back (resources removed)
                                                    ├→ rollback_required (manual cleanup)
                                                    └→ cancelled
```

Retryable failures (5xx, 429, timeouts) return the job to the queue with `attempt+1`; after
`min(max_attempts, 3)` the failure becomes deterministic and rollback runs.

### 4.2 Steps (install)

| # | Step | Cloudflare call | Idempotency |
|---|---|---|---|
| 1 | `validate_account` | `GET /workers/scripts`, `GET /d1/database`, `GET /accounts/{id}` | read-only probe |
| 2 | `ensure_subdomain` | `GET/PUT /accounts/{id}/workers/subdomain` | returns existing or claims derived name |
| 3 | `create_database` | `POST /accounts/{id}/d1/database` | `ensureDatabase` matches by name first |
| 4 | `upload_worker` | `PUT /accounts/{id}/workers/scripts/{name}` (multipart) | full re-upload, same bindings |
| 5 | `enable_workers_dev` | `POST …/scripts/{name}/subdomain` | set-to-true |
| 6 | `configure_schedule` | `PUT …/scripts/{name}/schedules` | replace-set |
| 7 | `verify_endpoint` | `GET https://{name}.{sub}.workers.dev/` | retries with backoff, asserts marker |
| 8 | `finalize` | — | writes the panel row |

### 4.3 Executor and leases

`deployment_jobs.locked_until` + `lease_owner` form a lease acquired with a single
`UPDATE … RETURNING` statement (SQLite `RETURNING`, supported by D1). Only the lease holder advances a job.
Triggers:

* Telegram webhook → `kickExecutor()` → `ctx.waitUntil(drain(...))` capped by `JOB_SLICE_MS`;
* cron `* * * * *` → `drain()` continues whatever the request pass could not finish;
* dashboard/bot "refresh" → re-reads the job and edits the Telegram progress message.

Progress messages are stored on the job (`telegram_chat_id`, `telegram_message_id`) so every pass edits the
same message instead of spamming the chat.

### 4.4 Backup and restore

* **Backup**: `POST /d1/database/{id}/export` (`output_format: "polling"`) → poll `current_bookmark` →
  download `signed_url` → `PUT` into R2 under `backups/<panelUid>/<jobId>.sql` (deterministic key, so a retry
  overwrites its own dump) → `panel_backups` row with checksum + 30-day expiry.
* **Restore**: `POST /import {action:"init", etag: md5(dump)}` → `PUT` the bytes to the returned upload URL →
  `POST {action:"ingest"}` → poll `{action:"poll"}` until `complete`.
* Both are job-based; the UI shows the same progress bar as installs.

### 4.5 Deletion safety

`preflight` requires tracked resources; `delete_worker` refuses when the tracked `external_id` differs from
the panel's own `worker_name`; `delete_database` refuses when the tracked uuid differs from the panel's
`d1_database_id`. A test asserts that a tampered ledger blocks deletion.

## 5. Security architecture

| Control | Implementation |
|---|---|
| Webhook authenticity | `X-Telegram-Bot-Api-Secret-Token` constant-time compare, min 16-char secret |
| Replay protection | `webhook_events.dedupe_key UNIQUE` insert-before-handle |
| Rate limiting | D1 fixed windows (`rate_limits`): 40 updates/min/user, 120 webhook req/min/IP, 10 connect submissions/10 min/IP |
| Token handling | entered only on the HTTPS connect page; sealed with AES-256-GCM; AAD binds tenant; never logged, never echoed, never returned by any endpoint |
| Key rotation | `key_version` column + `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` accepted for reads |
| Session (dashboard) | `<id>.<hmac>` cookie, `HttpOnly; Secure; SameSite=Lax`, server-side expiry in `admin_sessions`, staff-only |
| CSRF | double-submit token = `HMAC(SESSION_SIGNING_KEY, "csrf:"+sessionId)`, verified on every POST |
| Authorisation | `user_roles` in D1; `requireAdmin()` in bot handlers and `authenticate` in dashboard |
| Tenant isolation | `userId` predicate in every tenant query (asserted by tests) |
| Input validation | `src/security/validation.ts` — token shape, worker name, account id (32 hex), uuid, Persian digits, body size |
| SQL injection | only bound parameters; no string concatenation of user data (the only dynamic SQL is a whitelisted column list in `updatePlan`) |
| SSRF | the bot only fetches `workers.dev` URLs it derives from a validated worker name and the account's own subdomain |
| Secret leakage | `src/utils/logger.ts` redacts keys and value patterns; `CloudflareClient.toJSON()` and `TelegramClient.toJSON()` never expose tokens |
| Error hygiene | `AppError.userMessage` is Persian and safe; details stay in logs with a trace id |

## 6. Scalability notes

* Stateless request handling; all state in D1/KV/R2 — any isolate can serve any request.
* Global job concurrency capped by `system_settings.max_global_concurrency` (default 6) to stay inside
  Cloudflare API rate limits; per-user concurrency comes from the plan.
* Uploads of a 2.9 MB panel bundle are the heaviest operation; the executor runs one step per pass so a
  single invocation never exceeds the CPU/wall budget.
* `drain()` caps each pass at 12 steps and `JOB_SLICE_MS` milliseconds.

## 7. Known limitations (documented, not hidden)

1. **No payment provider** — `FEATURE_PAYMENTS=false`; `payments` table exists as a manual ledger only.
2. **Support tickets** — the table and admin flows exist; the user-facing "open ticket" form is not exposed
   in the bot in v1.0.0 (support is a Telegram contact). Recorded in RELEASE_NOTES.
3. **Custom domains** — `allow_custom_domain` is a plan flag, but attaching a hostname requires zone access
   the token does not have; not implemented.
4. **Queue-based execution** — the resumable D1 job engine is used instead of Cloudflare Queues (Queues
   requires the paid plan and a second binding); the architecture already isolates the executor behind
   `drain()`/`executePass()` so a Queue consumer can call it without changes.
5. **Panel password** — the bot does not set the panel's admin password (the panel claims itself on first
   visit). Documented in OPERATIONS.md.
