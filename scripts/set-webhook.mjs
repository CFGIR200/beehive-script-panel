#!/usr/bin/env node
/**
 * Registers the Telegram webhook against a deployed BEE.HIVE BOT Worker.
 *
 *   node scripts/set-webhook.mjs --url https://beehive-bot.example.workers.dev --secret <TELEGRAM_WEBHOOK_SECRET>
 *
 * The secret is sent in the Authorization header to the Worker's one-time
 * endpoint, which then calls setWebhook with it as `secret_token`. Neither the
 * bot token nor the secret is ever written to a file.
 */

const args = process.argv.slice(2);

function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const baseUrl = arg("url") || process.env.PUBLIC_BASE_URL;
const secret = arg("secret") || process.env.TELEGRAM_WEBHOOK_SECRET;

if (!baseUrl) {
  console.error("Missing --url (or PUBLIC_BASE_URL env var).");
  process.exit(1);
}
if (!secret) {
  console.error("Missing --secret (or TELEGRAM_WEBHOOK_SECRET env var).");
  process.exit(1);
}

const endpoint = `${baseUrl.replace(/\/+$/, "")}/admin/set-webhook`;

const response = await fetch(endpoint, {
  method: "POST",
  headers: { Authorization: `Bearer ${secret}` },
});

const body = await response.text();
if (!response.ok) {
  console.error(`Failed (${response.status}): ${body}`);
  process.exit(1);
}

console.log("Webhook registered:");
console.log(body);
