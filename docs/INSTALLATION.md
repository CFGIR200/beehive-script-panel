# INSTALLATION — BEE.HIVE BOT v1.0.0

Two audiences: **(A) the operator** who deploys the bot, and **(B) the customer** who connects their
Cloudflare account. Deployment mechanics live in `docs/DEPLOYMENT.md`.

---

## A. Operator checklist

| Step | Command / action | Done when |
|---|---|---|
| 1 | `npm install --no-audit --no-fund` | no errors; `npm run doctor` silent |
| 2 | `npm run typecheck` | clean |
| 3 | `npm test` | 94 passing |
| 4 | `npx wrangler d1 create beehive_bot` | id copied into `wrangler.toml` |
| 5 | `npx wrangler kv namespace create BEEHIVE_CACHE` | id copied into `wrangler.toml` |
| 6 | `npx wrangler r2 bucket create beehive-artifacts` | bucket exists |
| 7 | fill `PUBLIC_BASE_URL`, `BOT_USERNAME`, `BOOTSTRAP_ADMIN_TELEGRAM_ID` | no `<PLACEHOLDER>` left |
| 8 | put the 4 required secrets (+ optional previous key) | `npx wrangler secret list` shows them |
| 9 | `npm run db:migrate:remote` | 4 migrations applied |
| 10 | `node scripts/upload-panel-artifact.mjs` | printed SHA-256 equals `PANEL_ARTIFACT_SHA256` |
| 11 | `npm run deploy` | Worker URL shown |
| 12 | `node scripts/set-webhook.mjs --url … --secret …` | `{"ok":true,…}` |
| 13 | `curl <url>/health` | `{"ok":true,…}` |
| 14 | `/start` in Telegram → `/id` | matches the bootstrap id |
| 15 | wait ≤ 60 s, check `user_roles` | `super_admin` row exists |
| 16 | dashboard login at `/dashboard/login` | overview renders |

## B. Customer journey (what the bot walks them through)

1. **`/start`** — welcome + menu.
2. **«اتصال Cloudflare»** — the bot explains that the token must *never* be pasted into the chat and shows a
   button that opens the Cloudflare token page with the three scopes preselected:
   *Workers Scripts: Edit*, *D1: Edit*, *Account Settings: Read*, **All accounts**, **No expiration**.
3. **«دریافت لینک اتصال امن»** — a 15-minute, single-use link is sent as a separate message.
4. On the link: paste the token → the bot verifies it with `/user/tokens/verify`, lists the accounts and
   probes the three permissions. One account ⇒ done; several ⇒ a picker.
5. **«ساخت پنل جدید»** — the bot asks which account and a worker name (or generates one, e.g. `honey-8f3k`).
6. Progress message: validate → subdomain → D1 → upload → workers.dev → cron → verify → done.
7. Final message contains the panel URL (`https://<worker>.<account-subdomain>.workers.dev/panel`), the D1
   name, the version and the **recovery key** (shown once, sealed in the bot database).
8. The customer opens the panel, sets the panel admin password on first visit, and adds proxy users there.

## Configuration reference

### Worker `[vars]`

| Var | Default | Purpose |
|---|---|---|
| `ENVIRONMENT` | `production` | forces HTTPS on `PUBLIC_BASE_URL` |
| `PUBLIC_BASE_URL` | — | absolute base for connect links |
| `BOT_USERNAME` | — | shown on the landing page and in `/help` |
| `BOOTSTRAP_ADMIN_TELEGRAM_ID` | `0` | promotes this id to `super_admin` once, while no super admin exists |
| `PANEL_ARTIFACT_KEY` | `panel/beehive-panel-3.1.13.js` | R2 object key |
| `PANEL_ARTIFACT_VERSION` | `3.1.13` | default target version |
| `PANEL_ARTIFACT_SHA256` | audited digest | integrity anchor |
| `PANEL_COMPATIBILITY_DATE` | `2025-03-10` | stamped on provisioned panels |
| `PANEL_CRON` | `0 * * * *` | cron applied to provisioned panels |
| `PANEL_VERIFY_ATTEMPTS` | `5` | health-verify attempts after upload |
| `PANEL_VERIFY_INTERVAL_MS` | `2000` | backoff base for those attempts |
| `JOB_SLICE_MS` | `22000` | per-invocation job budget |
| `FEATURE_SELF_SERVE_INSTALL` | `true` | global install switch (also `system_settings.install_enabled`) |
| `FEATURE_PAYMENTS` | `false` | no payment provider in v1.0.0 |
| `SUPPORT_CONTACT` | `@BEESELL_GP` | shown in `/help` |

### Secrets (`wrangler secret put`)

`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` (base64/32 bytes),
`SESSION_SIGNING_KEY`, optional `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`.

### Bindings

`DB` (D1, required), `CACHE` (KV, optional cache), `ARTIFACTS` (R2 — panel bundle + backups; **required for
install and backup**).

## Panel-side variables the bot sets (from `docs/INITIAL_AUDIT.md`)

The bot always creates the `DB` D1 binding and `PANEL_TITLE`. It registers `RECOVERY_KEY` as a Worker
**secret** (never a plain var). `PANEL_API_TOKEN`, `PANEL_DEBUG`, `PANEL_BRAND`, `PANEL_STREAM_PATH` and
`LOCAL_PREVIEW` are supported by the audited bundle but are not set by default — the panel UI manages
everything else at runtime.

## Local development

```bash
cp .dev.vars.example .dev.vars      # fill local values (git-ignored)
npm run db:migrate:local
npm run dev                         # http://localhost:8787
```

For local Telegram testing expose the dev server (e.g. `cloudflared tunnel`) and point the webhook at it, or
drive the internal modules directly from `tests/`.
