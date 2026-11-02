# Testing report — BEE.HIVE BOT v1.0.0

## How the suite runs

Tests execute inside the **real Workers runtime** (`workerd`) through
`@cloudflare/vitest-pool-workers`: D1, KV and R2 are the actual Miniflare implementations, and the four
migrations in `migrations/` are applied to the test D1 before each file runs
(`tests/apply-migrations.ts`). Only the two external networks are mocked:

* **Cloudflare API** — `tests/helpers.ts::installCloudflareMock()` speaks the real JSON envelope, asserts the
  `Authorization` header, models pagination, D1 export/import polling, workers.dev serving, and can inject
  failures (`failUploadTimes`, `denyPermissions`, per-call `override`).
* **Telegram API** — stubbed per-test where the code path sends a message.

```bash
npm test          # pretest toolchain guard → vitest run
npm run typecheck # tsc --noEmit
npm run doctor    # dependency versions match the verified set (silent when OK)
```

`npm test` first runs `scripts/check-toolchain.mjs`, which refuses to start if `vitest`,
`@cloudflare/vitest-pool-workers`, `wrangler` or `typescript` drifted from the pinned versions (e.g. after an
`npm audit fix --force`), printing the fix instead of a cryptic esbuild error. Covered by
`docs/TROUBLESHOOTING.md` → "Install / toolchain".

## Result

```
 Test Files  9 passed (9)
      Tests  94 passed (94)
   Duration  ≈ 6 s
```

| Suite | File | Tests | What it proves |
|---|---|---|---|
| Crypto | `tests/unit/crypto.test.ts` | 8 | AES-256-GCM round-trip, unique IVs, tenant-bound AAD, tamper rejection, key rotation, 32-byte key enforcement, HMAC, random hex |
| Validation & UI guards | `tests/unit/validation.test.ts` | 15 | token/account-id/worker-name/uuid shapes, Persian digit normalisation, callback parsing, redaction, message splitting |
| Cloudflare client | `tests/unit/cloudflare-client.test.ts` | 17 | bearer header, 401→`CF_UNAUTHORIZED`, 403→`CF_FORBIDDEN`, retry on 5xx, no retry on 4xx, pagination, token-free serialisation, MD5 etag vectors, planner order & rollback map, worker bindings (`DB` + `RECOVERY_KEY` as secret) |
| Provisioning (integration) | `tests/integration/provisioning.test.ts` | 11 | full install (8 steps), resume after a transient 503, hash-mismatch refusal, rollback of created resources, plan limit, duplicate worker name, update/redeploy, backup→R2, restore→import, delete with ownership, degraded health, lease exclusion, cancellation |
| Subscriptions | `tests/integration/subscriptions.test.ts` | 13 | seeded plans, default-plan fallback, grant/replace/expire, install kill-switch, update/backup flags, panel counting, settings + idempotency |
| Tenant isolation (security) | `tests/security/tenant-isolation.test.ts` | 10 | cross-tenant panel read, credential load, install, job cancel, delete, recovery-key reveal, account listing; role classification; single bootstrap promotion; block/unblock |
| Webhook (security) | `tests/security/webhook.test.ts` | 13 | missing/wrong secret, correct secret, replay dedupe, 405/400, per-user rate limit, blocked user, connect page 404/200/expiry/attempt bookkeeping, two-step connect, plaintext token absent from the DB |
| End-to-end | `tests/e2e/full-flow.test.ts` | 6 | `/health`, landing page, dashboard protection, staff login via Telegram code (wrong code → 401, right code → 303 + HttpOnly cookie, cookie unlocks the dashboard, tampered cookie rejected), non-staff gets no code, connect→install→dashboard→delete, CSRF rejection |
| Harness | `tests/setup.test.ts` | 1 | D1 binding works |

## Bugs the suite caught during development (fixed, not hidden)

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | A 403 response with Cloudflare error code `10000` was classified as `CF_UNAUTHORIZED` instead of `CF_FORBIDDEN` | `cloudflare-client.test.ts` | classify on HTTP status first (`src/cloudflare/client.ts`) |
| 2 | A failing step overwrote an already-`rolled_back` job back to `failed` | `provisioning.test.ts` | `jobs.fail` preserves `rolled_back`/`rollback_required`/`cancelled` |
| 3 | Update/redeploy jobs could not resolve the `workers.dev` subdomain (only install computed it) | `provisioning.test.ts` (redeploy) | `ensure_subdomain` added to the update plan, and `verify_endpoint` now prefers the panel's stored URL |
| 4 | Verification retried with a fixed 2 s×n cadence, making failure paths take ~20 s | `provisioning.test.ts` (timeout) | cadence moved to `PANEL_VERIFY_ATTEMPTS` / `PANEL_VERIFY_INTERVAL_MS` |
| 5 | Dashboard login flow issued a code but the verify page had no handle to pair it with | `e2e/full-flow.test.ts` | `createLoginCode` returns `{handle, code}` and `verifyLoginCode(handle, code)` validates both |

## Coverage by requirement

| Master-prompt requirement | Test evidence |
|---|---|
| Encryption | crypto suite |
| Telegram update parsing / authentication | webhook suite |
| Permission validation | `permissions.probe` exercised in install + connect flow |
| Cloudflare API client | client suite + provisioning suite assertions on the mock's recorded calls |
| Provisioning planner | planner tests (`stepNames`, phases, rollback map) |
| Subscription limits | subscriptions suite |
| Tenant isolation | tenant-isolation suite (7 distinct vectors) |
| D1 / KV / R2 integration | every integration test (real Miniflare bindings) |
| Job queue / deployment workflow | provisioning suite (lease, resume, rollback, cancel) |
| Session expiry / replay / rate limit / secret leakage | webhook + tenant-isolation + crypto suites |
| Delete operations | delete + ownership tests |
| Admin access | role tests + dashboard login tests |
| End-to-end scenario | `full-flow.test.ts` |

## What is **not** covered by automated tests (and why)

1. **Real `api.cloudflare.com` calls.** No test touches a real account; that would require an operator's
   credentials. The mock reproduces the documented envelopes and error codes; live validation is the
   operator's smoke test in DEPLOYMENT.md §9.
2. **Real Telegram delivery.** The API client is exercised but the network is stubbed; delivery is verified
   manually with `/start`.
3. **A real 9 MB panel upload.** Tests use a small bundle with a matching registered hash; the size/limit path
   is documented (`docs/INITIAL_AUDIT.md` §7 R3) rather than simulated.
4. **Browser rendering of the dashboard.** HTML is asserted by string checks (tabs, tables, forms, CSRF), not
   by a headless browser.
5. **Payments.** No provider is integrated in v1.0.0, so there is nothing to test.

## Reproducing

```bash
npm ci
npx vitest run --reporter=verbose
npx wrangler deploy --dry-run --outdir dist   # bundle sanity (364.07 KiB, 76.67 KiB gzip)
```
