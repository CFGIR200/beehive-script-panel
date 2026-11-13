# INITIAL AUDIT — BEE.HIVE BOT (Phase 1)

Date: 2026-11-01
Auditor: engineering team acting on the master prompt
Scope: every artefact supplied in the request, audited before any code was written.

> **2026-11-13 — BEEHIVE-PATCH-1 addendum:** the approved bundle was rebuilt with
> PATCH-1 (`docs/PATCH-EXTERNAL-CONFIGS.md`): per-user external raw configs are no
> longer served to inactive/exhausted users. Intermediate pinned digest:
> `7381d693589a7699496d8ca86f6fc020199bb7e092d81b02d54d72f0f8919bc0`.
> The obfuscation scheme, loader and §3 findings are unchanged; only the two
> subscription-serving code paths described in the patch note were modified.
>
> **2026-11-13 — BEEHIVE-PATCH-2 addendum:** rebuilt again with PATCH-2
> (`docs/PATCH-EXTERNAL-CONFIGS.md`): external-config library bulk-apply to users
> (`POST /api/external-configs/apply` + `apply_external` bulk action) and an
> auto-include toggle that merges the resolved library into every active,
> within-quota subscription. Current pinned digest:
> `0e164a0a8f985e9024ebd1a7de059dedd0915e132638e93513290687eb963cd4`
> (9,077,186 bytes; gzip -9 2,805,266 bytes — under the 3 MB free-plan limit).
> Obfuscation scheme, loader and §3 findings remain unchanged.

---

## 0. What was actually delivered to the workspace

The prompt references three reference artefacts. **Only two arrived**, and this document records that
honestly rather than pretending otherwise.

| Referenced artefact | Present? | Notes |
|---|---|---|
| `BEE.HIVE BOT.zip` (screenshots + Cloudflare setup docs) | ⚠️ **Not as a ZIP** | 17 PNG screenshots were supplied individually (`uploads/Screenshot 2026-11-01 *.png`). No ZIP file exists in the workspace. |
| `worker_beehive_user_external_configs(3).txt` | ✅ Present | 9,040,717 bytes, 19 lines, obfuscated Worker source v3.1.13 |
| `BEEHIVE-BOT-cloudflare-workers-v0.1.zip` (bot skeleton) | ❌ **Missing** | No ZIP, no `src/index.ts`, `src/telegram.ts`, `src/crypto.ts`, `migrations/0001_init.sql`, `wrangler.toml` were supplied. The skeleton described in §3 of the prompt therefore had to be **written from scratch**, not audited. |

**Consequence:** nothing in this repository is derived from a prior bot skeleton. The structure described
in the prompt (`src/index.ts`, `src/telegram.ts`, `src/crypto.ts`, `src/types.ts`, `src/panel-template.ts`,
`migrations/0001_init.sql`, `wrangler.toml`, `README.md`) is honoured, but every file is new work and was
designed from the audited panel source and the Cloudflare/Telegram documentation.

---

## 1. Method (safety first)

The supplied Worker source is obfuscated and its loader ends with `new Function(...)`, i.e. dynamic code
execution. It was **never executed** — not in Node, not in `workerd`.

The deobfuscation was performed by re-implementing the loader's *pure string transforms* in a standalone
script (`audit/decode.mjs`, kept outside the product tree) and writing the resulting text to disk:

1. `cart_box` — a 9 MB JS string literal, XOR-encoded per character with key `93`.
2. The result is base64; `atob` decodes it to bytes.
3. Each byte is XORed with a repeating 16-byte key:
   `67,183,203,119,94,188,75,43,155,243,146,151,157,44,3,10`.
4. `TextDecoder` produces the final payload (**3,214,279 characters**, 22,973 lines).
5. The original loader wraps that payload in `new Function("connect","connect2", payload)(connect, connect2)`.

Step 5 was **not** performed. The decrypted text was read as source (it is an ESBuild bundle that retains
`// src/...` module markers), and every claim below comes from reading that text.

Artifact integrity anchor:

```
sha256(worker_beehive_user_external_configs.txt)
  = b763b2f8b09d16d13f3b4971c1df069c7c428f0955b28fe78f1009515796eab4
gzip size = 2,946,628 bytes (2.9 MB)  raw = 8.7 MiB
```

`sha256` and the artifact key are registered in `migrations/0002_seed_plans.sql` (`panel_versions`) and in
`wrangler.toml`. The installer refuses to deploy a bundle whose digest differs.

---

## 2. Loader behaviour (what the obfuscation does at runtime)

| Step | Mechanism | Risk |
|---|---|---|
| 1 | XOR every char of a 9 MB literal with `93` | none (pure data) |
| 2 | `atob` → binary string | none |
| 3 | byte-wise XOR with a 16-byte key | none |
| 4 | `TextDecoder` | none |
| 5 | `new Function(...)(connect, connect2)` | **dynamic code execution at request time** |

Implication for this product: the panel performs `new Function` on every Worker start. Cloudflare's
runtime permits it, but it means the deployed script is opaque to review and to error stacks. BEE.HIVE BOT
therefore treats the bundle as an **immutable, hash-pinned binary artifact** and never edits or merges it.

The only build-time dependency is `import { connect } from "cloudflare:sockets"` (line 2), passed into the
payload as an argument. This is the audited, load-bearing reason the deployed panel needs outbound socket
support — it is a proxy panel.

---

## 3. Panel capabilities (from the decrypted source)

### 3.1 Module inventory (from retained `// src/...` markers)

```
src/util.js              src/config.js            src/db.js
src/proxy/sha224.js      src/proxy/blocklist-data.js  src/proxy/dns.js
src/proxy/proxies.js     src/proxy/upstream.js    src/proxy/public-lists.js
src/proxy/health.js      src/proxy/rotation.js    src/proxy/protocol.js
src/proxy/handler.js     src/proxy/stream.js      src/proxy/udp.js
src/proxy/geo.js         src/integrity.js         src/settings.js
src/accounting.js        src/jobs.js              src/quota.js
src/auth.js              src/router.js            src/subscription.js
src/api/users.js         src/api/settings.js      src/api/tools.js
src/api/system.js        src/ui/*                  (templates, design system, client JS, PWA)
```

### 3.2 Feature matrix

| Area | Capability | Evidence (decrypted source) |
|---|---|---|
| Protocols | VLESS and/or Trojan users, `connection_type = "vless"\|"trojan"\|"vless+trojan"` | `normalizeUserInput` |
| Subscription output | plain text (`/sub/`), `/feed/`, sing-box (`/singbox/`), Xray (`/xray/`), Clash (`/clash/`) | `Router.subscription` |
| Per-user quota | `limit_gb`, `limit_req`, `used_gb`, `used_req`, lifetime counters, auto-reset intervals | `USER_COLUMNS`, `quota.js` |
| User CRUD | list/create/update/delete + `sub_token` rotation | `api/users.js`, `DbService` |
| Clean IP pools | named pools, max 10 pools × 100 IPs | `MAX_IP_POOLS`, `ip_pools` table |
| IP rotation | automatic rotation per user, lease-based rotation state | `proxy_rotation_state`, `rotation.js` |
| Anti-DPI | fragment length/interval, advanced fragment, cipher suites, TLS mask | `antiDpiParams` |
| Blocking | porn/ads blocklists, per-user flags | `blocklist-data.js`, `block_porn`, `block_ads` |
| Public proxy scrape | `/api/tools/public-proxies` fetches and health-checks public SOCKS/HTTP proxies | `api/tools.js` |
| Status page | public per-user status at `/status/<sub_token>` with usage payload | `Router.statusPage` |
| Admin UI | SPA at `/panel`, `/login`, `/admin`, design-system showcase, PWA manifest + service worker | `src/ui/*` |
| Auth | panel password (sha256), HMAC session tokens, session registry in `settings`, brute-force throttle, `RECOVERY_KEY` recovery, `PANEL_API_TOKEN` automation token | `src/auth.js` |
| Cron work | `scheduled()` runs `runScheduledJobs` + `flushAll` (traffic accounting, resets, rotation) | `src/index.js` |
| Accounting | request counting with a daily ceiling (`CF_DAILY_REQUEST_LIMIT = 100000`) | `accounting.js` |

### 3.3 Runtime contract (what the bot must supply)

Exactly one **required** binding, and a handful of optional variables. This is the single most important
finding for the provisioning engine.

| Name | Kind | Required | Effect |
|---|---|---|---|
| `DB` | D1 binding | **yes** | Without it the Worker returns HTTP 500 `{"error":"D1 binding missing"}` |
| `RECOVERY_KEY` | secret | no | Enables password recovery via `/api/recover` |
| `PANEL_API_TOKEN` | secret | no | Bearer token for automation API access |
| `PANEL_DEBUG` | var | no | Verbose auth diagnostics in logs |
| `PANEL_TITLE` | var | no | UI title |
| `PANEL_BRAND` | var | no | Brand line |
| `PANEL_STREAM_PATH` | var | no | Path prefix for stream endpoints |
| `LOCAL_PREVIEW` | var | no | Lenient same-origin check for local preview |

No KV, R2, Queues, Durable Objects, service bindings or assets are referenced anywhere in the bundle.
`wrangler.toml` in this repository matches that contract (the bot's own KV/R2 are for BEE.HIVE BOT, not for
the panel).

### 3.4 Panel D1 schema (created by the panel itself)

The panel calls `DbService.ensureSchema(env.DB)` on **every request** and creates/migrates its own tables:

- `users` — 44 columns (username, uuid, sub_token, trojan_hash, quota, rotation, anti-DPI, blocking, timestamps…)
- `settings` — key/value (brand, defaults, `panel_password`, `session_salt`, `valid_sessions`)
- `proxy_rotation_state` — PK `(user_id, slot_index)` + lease columns
- `ip_pools` — named clean-IP pools
- indexes: `idx_users_uuid`, `idx_users_trojan_hash`, `idx_users_active`, `idx_users_sub_token`

**Production consequence:** BEE.HIVE BOT must **not** run panel migrations. It only creates an empty D1
database and binds it as `DB`; the panel bootstraps itself. Any migration run by the bot would race with the
panel's own idempotent DDL.

### 3.5 Panel HTTP surface (for routing/verification, not for the bot)

```
/manifest.json /manifest.webmanifest /sw.js /service-worker.js /icon-*.png /robots.txt
/sub/<token> /feed/<token> /singbox/<token> /xray/<token> /clash/<token>
/status/<sub_token>
/panel  /login  /admin           (SPA; redirects to login when unauthenticated)
/design-system /showcase
/api/setup-password /api/login /api/recover /api/logout /api/client-debug
/api/users*  /api/settings /api/ip-pool(s) /api/external-configs /api/change-password
/api/flush-cache /api/overview /api/ip-pools/* /api/tools/* /api/system/*
```

Health marker used by the bot's verification step: the string **`Bee.Hive`** appears in the panel's HTML
(brand default `⚡️ Bee.Hive Panel ⚡️`) and in the fallback page, so a 200 response containing it proves the
Worker is serving the panel rather than a Cloudflare error page.

---

## 4. Version discrepancy (recorded, not resolved)

| Source | Version |
|---|---|
| File header comment | `DCVERSION:3.1.13` |
| `src/config.js` → `VERSION` constant | `3.1.12` |

The bundle was not modified. The registry row records version `3.1.13` (as the operator declares it) and the
note in `panel_versions.notes` documents the internal constant. If the vendor fixes this, re-register the
artifact and bump `PANEL_ARTIFACT_VERSION`.

---

## 5. Security observations about the supplied panel

These are **findings about the supplied bundle**, not defects introduced by this project. They are recorded
because BEE.HIVE BOT markets the panel to customers, and the operator should know.

1. **Password hashing** — `sha256Hex(password)` with no salt or KDF (see `setupPassword`). The stored value
   is in `settings.panel_password`. Weak passwords are cheap to attack offline if the D1 database leaks.
   *BEE.HIVE BOT cannot fix this without modifying the vendor bundle*; the mitigation available in v1.0.0 is
   that the bot never stores the panel password and advises a long random panel password.
2. **Session tokens** — `jti.expires.hmac(sha256(panel_password):session_salt, …)`, timing-safe compared, and
   revocable through the `valid_sessions` registry. Sound design, but rotating the password invalidates
   every session (which is intended).
3. **`new Function` at runtime** — every deploy executes dynamically generated code; impossible to audit at
   the edge. Accepted because the artifact is hash-pinned.
4. **Live network egress** — `cloudflare:sockets.connect` plus DoH lookups to `cloudflare-dns.com`; the panel
   is a proxy and will consume the host account's egress/quota, not the bot's.
5. **`RECOVERY_KEY` comparison** in `/api/recover` uses `!==` on strings rather than a timing-safe compare.
   Low practical risk (it is an operator-set secret), but it is what the bundle does.
6. **No secrets found in the bundle.** No hard-coded API tokens, bot tokens, private keys, or account ids
   were discovered. The recovery/API tokens are read from `env` only.

---

## 6. Cloudflare setup flow (reconstructed from the 17 screenshots)

Facts visible in the screenshots, used to design the connect page and the permission probes:

| Screenshot | Observation |
|---|---|
| `020720` / `020734` | Reference bot onboarding: "ساخت پنل جدید", account list of many `*@duck.com` Cloudflare accounts, per-account panel counts |
| `020749` | Token instructions: press the button → *Create Token* → *Continue to summary* → send the token back |
| `020759` / `020815` | Deep link to `dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"workers_scripts","type":"edit"},{"key":"d1","type":"edit"},{"key":"account_settings","type":"read"}]&accountId=*&zoneId=all&name=DevCop` |
| `033415` | Token create form: name `DevCop`, permissions **Account · Workers Scripts · Edit**, **Account · D1 · Edit**, **Account · Account Settings · Read**, *Include → All accounts*, **No expiration** |
| `033443` | Token summary page confirms the three policies and "All IP addresses allowed" |
| `033503` | Token created page shows the `cfut_…` value once, plus a `curl` verification command |
| `033525` | The reference bot asks the user to paste the token **into the chat** |
| `033606` | Accounts list after connecting: `Aged-parted-clinic@duck.com's Account` first, then the others, each showing a panel count |
| `033634` | Connected-account card: name, account id `7f923e334be07cf56695d3c848df0221`, "with «disconnect» the token is stored encrypted in D1…" |
| `033704` | "آخرین تنظیمات" screen: panel name `piku-q7b9`, recovery key `fdd3d2516551a009ac53387ff71b032b21098918641e5176`, IP rotation on, domain link on |
| `033735` / `033745` | Provisioning progress: bundle prepared (`KB 9728` = 9.5 MB), D1 `noka-gvb8` created (`database_id a81863e1-05c7-4ccd-b3f4-cbdc66fce334`), Worker `piku-q7b9` uploaded, secrets `RECOVERY_KEY` + `PANEL_API_TOKEN_FOR_PANEL` set, cron `0 * * * *` registered, `workers.dev` enabled |
| `033809` | Panel ready: `https://piku-q7b9.aged-parted-clinic.workers.dev/panel`, recovery key, panel id |
| `033830` | The URL opened from the chat |

### Design decisions derived from this

1. **The reference bot receives the API token inside Telegram.** The master prompt forbids that, and this
   implementation does not do it: the token is entered only on an HTTPS one-time page
   (`/connect/<token>`), and the message content never contains it. Evidence: `src/web/connect-page.ts`.
2. **The reference flow creates assets named after the account** (`piku-q7b9`), uses a random D1 name
   (`noka-gvb8`), and sets cron `0 * * * *` with `workers.dev` enabled — the same target state this
   provisioning engine produces (`src/provisioning/steps.ts`).
3. **The permission set is exactly three scopes** (`Workers Scripts:Edit`, `D1:Edit`, `Account Settings:Read`),
   which is what `src/cloudflare/permissions.ts` probes and what the bot's token deep-link requests.
4. **The reference bot's secret name** is `PANEL_API_TOKEN_FOR_PANEL`; the audited bundle reads
   `PANEL_API_TOKEN`. The bot uses the name the **bundle** declares, and registers `RECOVERY_KEY` as a
   Worker secret — see `PANEL.optionalSecrets` in `src/config/constants.ts`.

---

## 7. Risk register

| # | Risk | Impact | Mitigation in v1.0.0 |
|---|---|---|---|
| R1 | Panel bundle is opaque (`new Function`) | Cannot review behaviour per release | Hash-pinned artifact; bot refuses mismatched bytes; version registry with `is_active` kill-switch |
| R2 | Panel password hashing is unsalted SHA-256 | Offline cracking if D1 leaks | Documented; bot never stores the password; operator guidance in SECURITY.md |
| R3 | Bundle is 2.9 MB gzipped | Exceeds the 3 MB free-plan script budget for the *panel*, not the bot | Documented in DEPLOYMENT.md; deployment requires Workers Paid for the customer account |
| R4 | Cloudflare API has no "read my token's scopes" endpoint | Cannot ask "is this token correct?" directly | Capability probes against the three read endpoints (`permissions.ts`); 403 ⇒ missing scope |
| R5 | D1 export/import are asynchronous and can be slow | Backup/restore may exceed one request | Job-based execution with resumable steps and polling budgets |
| R6 | Customers may connect a token with broader rights than needed | Blast radius | Bot only ever calls the three documented families; documented Least-Privilege template |
| R7 | Missing reference ZIPs (bot skeleton, screenshots-as-ZIP) | Prompt §3 could not be "audited" | Recorded here; skeleton designed from scratch |

---

## 8. Definition of Done for Phase 1

- [x] Every supplied artefact extracted and inspected
- [x] Obfuscation decoded statically, without executing the payload
- [x] Panel feature matrix, dependency matrix and runtime contract documented
- [x] All env vars / secrets / bindings identified (`DB`, `RECOVERY_KEY`, `PANEL_API_TOKEN`, four optional vars)
- [x] Panel API surface enumerated
- [x] Artifact hash pinned and enforced
- [x] Missing artefacts explicitly recorded (this document, §0)
- [x] Risk register produced
- [x] No secret from the screenshots or the bundle copied into source (`grep` for the `cfut_` token and the
      example keys returns nothing outside this document's redacted descriptions)
