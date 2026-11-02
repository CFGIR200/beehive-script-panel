# SECURITY — BEE.HIVE BOT v1.0.0

## 1. Threat model

| Adversary | Goal | Control |
|---|---|---|
| Anonymous internet | forge a Telegram update | webhook secret token (`X-Telegram-Bot-Api-Secret-Token`) compared in constant time; min 16 chars; secret absent ⇒ 500, mismatch ⇒ no processing |
| Telegram user (customer) | read/modify another customer's panels | `userId` predicate in every tenant query; tests in `tests/security/tenant-isolation.test.ts` |
| Customer | escalate to admin | roles in `user_roles`; `requireAdmin()` in every admin handler and in the dashboard; admin callbacks re-check authorisation |
| Customer | steal another customer's Cloudflare token | tokens are sealed with AAD `user:account:purpose`; a ciphertext moved to another tenant cannot be decrypted (tested) |
| Attacker with the bot DB | decrypt stored tokens | AES-256-GCM with a key held only in a Worker secret (never in D1); D1 leak alone is insufficient |
| Attacker with the Worker secret | impersonate | they already own the deployment; rotate `CREDENTIAL_ENCRYPTION_KEY` and `SESSION_SIGNING_KEY` and re-issue tokens |
| Replayer | replay a webhook | `webhook_events.dedupe_key UNIQUE`, insert-before-process |
| Flooder | exhaust rate limits / burn API quota | fixed-window limits in D1 (per user, per IP), global job concurrency cap |
| Forger | guess a connect link | 40-char random token (≈200 bits), stored only as SHA-256, 15-min TTL, single use, 5 attempts max, 10 submissions/10 min/IP |
| Forger | reuse a dashboard session | `HMAC(sessionId)` cookie + server-side session row + expiry + staff role re-check |
| Forger | CSRF a dashboard action | double-submit token bound to the session, verified on every POST |
| Malicious bundle consumer | SSRF through the bot | the bot only fetches `https://{validated-worker-name}.{account-subdomain}.workers.dev/`; the subdomain comes from the Cloudflare API, not from user input |
| Log scraper | read secrets out of logs | `src/utils/logger.ts` redacts sensitive keys and token-shaped values; `CloudflareClient`/`TelegramClient` serialise without tokens |

## 2. Cryptography

| Purpose | Algorithm | Notes |
|---|---|---|
| Cloudflare token at rest | AES-256-GCM, 96-bit random IV, 128-bit tag | AAD = `beehive:v1:<purpose>:<userId>:<accountRef>` |
| Panel recovery key at rest | AES-256-GCM, sealed JSON `{ciphertext,iv,keyVersion}` | AAD = `beehive:v1:panel_recovery_key:<ownerId>:<panelId>` |
| Session cookie signature | HMAC-SHA256 | key = `SESSION_SIGNING_KEY` |
| CSRF token | HMAC-SHA256 truncated to 128 bits | bound to the session id |
| One-time connect link / login codes | SHA-256 of `id:secret` | only hashes are stored |
| D1 import etag | MD5 (**required by the Cloudflare API**, not a security decision) | implemented locally; covered by test vectors |

Key rotation: `encrypted_credentials.key_version` records the version; sealing always uses the current key,
opening tries current then `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`.

```bash
# rotation procedure
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY_PREVIOUS   # current key
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY            # new key
# then, for every account: reconnect (which re-seals with the current key)
# finally remove the previous key:
npx wrangler secret delete CREDENTIAL_ENCRYPTION_KEY_PREVIOUS
```

## 3. Least privilege for customer tokens

The bot requests **exactly** what the audited panel needs:

| Scope | Why |
|---|---|
| `Workers Scripts : Edit` | upload/delete the panel Worker, toggle workers.dev, set cron |
| `D1 : Edit` | create/delete the panel database, export/import for backup/restore |
| `Account Settings : Read` | read the account's `workers.dev` subdomain |

No zone permissions, no DNS, no KV, no R2, no API-token management, no billing. The connect page and the
`/help` screen show this list; the token deep-link preselects it.

## 4. Secrets inventory (never in source control)

| Secret | Required | Rotatable | Consequence of loss |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | yes (BotFather revoke) | bot unreachable; panels unaffected |
| `TELEGRAM_WEBHOOK_SECRET` | yes | yes | forged updates possible until rotated; rotate + re-register webhook |
| `CREDENTIAL_ENCRYPTION_KEY` | yes | yes (with `…_PREVIOUS`) | all stored Cloudflare tokens must be re-entered |
| `SESSION_SIGNING_KEY` | yes | yes | dashboard sessions invalidated (users just log in again) |

`.gitignore` excludes `.dev.vars`, `.env*`, `.wrangler/`. `scripts/build-release.mjs` refuses to build an
archive that contains any of them.

## 5. Auditing

Every sensitive action writes to `audit_logs` with actor, target, severity, ip and trace id:
`panel.install.started`, `panel.update.started`, `panel.delete.started`, `panel.backup.started`,
`panel.restore.started`, `panel.recovery_key.revealed`, `cloudflare.connected`, `cloudflare.disconnected`,
`cloudflare.connect.failed`, `job.cancelled`, `user.blocked`, `user.unblocked`, `plan.updated`,
`settings.changed`, `broadcast.sent`, `dashboard.login`, `dashboard.logout`, `webhook.rate_limited`.

Retention: 90 days (`audit_logs` pruned by cron). The dashboard has a filtered audit view.

## 6. Deliberate non-goals / accepted risks

1. **The customer's Cloudflare account is trusted by definition.** Any token the customer grants can be used
   by that customer directly; the bot is not a security boundary against the account owner.
2. **Panels have no bot-controlled back door.** The bot does not set the panel's admin password and cannot
   read panel user data.
3. **The panel bundle contains `new Function` and unsalted SHA-256 passwords** (see
   `docs/INITIAL_AUDIT.md` §5). This is a vendor decision; the bot pins the artifact by hash and can disable a
   version instantly (`panel_versions.is_active = 0`).
4. **Rate limiting is fixed-window in D1.** It is correct but adds one write per request; a KV counter would
   be cheaper but not exact. Acceptable at the product's scale.
5. **No WAF/bot-management rules are provisioned by this project.** Operators should add a Cloudflare WAF
   rule limiting `/connect/*` and `/dashboard/login` to sane rates.

## 7. Incident response quick reference

| Symptom | First action |
|---|---|
| Suspected token compromise | `npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY` (rotate), notify customers to reconnect; panels keep running |
| Forged webhook traffic | rotate `TELEGRAM_WEBHOOK_SECRET`, re-run `scripts/set-webhook.mjs`, review `webhook_events` |
| Abusive customer | block the user (`/admin` → user card → block, or dashboard) — blocking stops bot commands but does **not** delete their panels |
| Runaway job loop | `UPDATE deployment_jobs SET status='cancelled' WHERE status NOT IN (…)`; lower `max_global_concurrency` |
| Leaked panel recovery key | the customer rotates the panel password inside the panel; the bot's copy is only a convenience value |
