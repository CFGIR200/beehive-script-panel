# API — BEE.HIVE BOT v1.0.0

Two surfaces: the **HTTP endpoints** of the Worker and the **internal module contracts** other code (or a
future Queue consumer) can rely on.

---

## 1. HTTP endpoints

All responses are `Cache-Control: no-store` and carry
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and a strict CSP.

### 1.1 `POST /telegram/webhook`

| Header | Required | Value |
|---|---|---|
| `X-Telegram-Bot-Api-Secret-Token` | yes | `TELEGRAM_WEBHOOK_SECRET` |
| `Content-Type` | yes | `application/json` |

| Response | Meaning |
|---|---|
| `200 {"ok":true}` | accepted (also returned for duplicates and for updates that fail validation — a non-2xx would make Telegram retry forever) |
| `400 {"ok":false,"error":"invalid_json"}` | body is not JSON |
| `405` | not POST |

### 1.2 Connect flow

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/connect/<token>` | — | `200` HTML form, `404` when the link is unknown/expired/used |
| `POST` | `/connect/<token>` | `token=<cloudflare api token>` | `200` HTML: either "connected" (one account) or the account picker; `400` invalid token/short token/permission error; `410`/`404` expired link; `429` rate limited |
| `POST` | `/connect/pick` | `handle=<opaque>&account=<account id>` | `200` HTML result; `400` unknown account; `410` expired handle; `429` too many attempts |

Security: the connect token is stored only as SHA-256, single use, 15-minute TTL, 10 submissions per IP per
10 minutes. The Cloudflare API token is never placed in a URL and never returned in any response.

### 1.3 Dashboard

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/dashboard/login` | — | login form |
| `POST` | `/dashboard/login` | — | `telegram_id` → sends a 6-digit code via Telegram (uniform response for non-staff) |
| `POST` | `/dashboard/verify` | — | `handle` + `code` → `303` + `Set-Cookie: bh_admin=…` |
| `POST` | `/dashboard/logout` | session | `303` + cleared cookie |
| `GET` | `/dashboard?page=overview\|users\|panels\|jobs\|plans\|audit\|settings` | session | HTML page |
| `POST` | `/dashboard/action` | session + `csrf` | `block_user`, `unblock_user`, `cancel_job`, `health_check`, `update_plan`, `set_setting` |

### 1.4 JSON

| Method | Path | Auth | Body |
|---|---|---|---|
| `GET` | `/health` | — | `{"ok":true,"version":"1.0.0","time":…}` or `503 {"ok":false}` |
| `GET` | `/api/dashboard/summary` | session cookie | `{ok, panels, activeJobs, panelStatus, jobStatus, serverTime}` |
| `GET` | `/api/dashboard/jobs` | session cookie | `{ok, jobs:[{id,kind,status,stepsDone,stepsTotal,error,updatedAt}]}` |

### 1.5 Operations

| Method | Path | Auth | Body |
|---|---|---|---|
| `POST` | `/admin/set-webhook` | `Authorization: Bearer <TELEGRAM_WEBHOOK_SECRET>` | registers the webhook and returns `getWebhookInfo` |
| `GET` | `/` , `/status` | — | public landing page |
| `GET` | `/robots.txt` | — | `Disallow: /` |

---

## 2. Module contract: provisioning engine

```ts
// src/provisioning/engine.ts
startInstall(env, config, { userId, telegramChatId, accountRef, requestedWorkerName?, version? })
  → { job, panel, workerName }
startUpdate(env, config, { userId, telegramChatId, panelId, redeploy? })      → { job, panel }
startDelete(env, config, { userId, telegramChatId, panelId })                 → { job, panel }
startBackup(env, config, { userId, telegramChatId, panelId })                 → { job, backupId }
startRestore(env, config, { userId, telegramChatId, panelId, backupId })      → { job }
cancelJob(env, jobId, userId?)                                               → boolean
kickExecutor(env, config, ctx?)
```

Errors are always `AppError` with a stable `code` (`LIMIT_REACHED`, `CONFLICT`, `ARTIFACT_INTEGRITY`,
`PERMISSION_MISSING`, `CF_*`, …), a Persian `userMessage` and a `retryable` flag.

```ts
// src/provisioning/executor.ts
executePass(env, config, jobId, { owner? }) → { jobId, outcome: "advanced"|"completed"|"failed"|"rolled_back"|"skipped"|"retry", step?, message? }
drain(env, config, budgetMs?)               → PassResult[]     // one pass, ≤12 steps
runJobToCompletion(env, config, jobId, budgetMs?) → PassResult
```

```ts
// src/cloudflare/*  (all functions take a CloudflareClient, so the token never travels further)
verifyToken, listAccounts, getAccount
uploadScript, deleteScript, scriptExists, enableWorkersDev, workersDevState,
getAccountSubdomain, createAccountSubdomain, setSchedule, getSchedules
listDatabases, findDatabaseByName, createDatabase, ensureDatabase, deleteDatabase,
query, exportDatabase, downloadExport, importDatabase
probe, summarize    // permission capability probe
```

```ts
// src/panels/*
createArtifactStore(env, config).load(version, expectedSha256, key) → PanelArtifact
check(panel) / checkAndRecord(env, panel) → HealthResult
view(env, panel) / viewForUser / listViewsForUser / revealRecoveryKey
```

```ts
// src/security/*
seal(plaintext, context, key) / unseal(sealed, context, key, previousKey?)
credentialContext(userId, accountRef, purpose)
hmacSha256Hex(secret, message) / randomHex(bytes)
requireString/requireCloudflareToken/requireWorkerName/requireUuid/… (all throw AppError)
consume(env, key, limit, windowMs) / enforce(…)
```

```ts
// src/database/repositories/*
users, accounts, panels, jobs, subscriptions, settings, audit, links, pending
// every tenant-scoped read takes userId and filters in SQL
```

---

## 3. Callback data (Telegram inline keyboards)

`namespace:action[:arg…]`, ≤ 64 bytes, validated by `parseCallback`.

| Pattern | Meaning |
|---|---|
| `menu:main` | main menu |
| `cf:list` `cf:link` `cf:pick:<ref>` `cf:disconnect:<ref>` | Cloudflare connection |
| `panel:list` `panel:new` `panel:new:<ref>` `panel:auto:<ref>` | panels / install wizard |
| `panel:view:<id>` `panel:health:<id>` `panel:reveal:<id>` | panel detail actions |
| `panel:update:<id>` `panel:update_go:<id>` `panel:redeploy:<id>` | update / redeploy |
| `panel:delete:<id>` `panel:delete_yes:<id>` | two-step delete |
| `panel:backup:<id>` `panel:restores:<id>` `panel:restore:<id>:<backup>` `panel:restore_yes:<id>:<backup>` | backup / restore |
| `job:refresh:<jobId>` `job:cancel:<jobId>` | job progress |
| `adm:*` | admin surfaces (re-authorised per handler) |
