#!/usr/bin/env node
/**
 * Uploads the approved Bee.Hive panel bundle to the R2 bucket used by the bot.
 * Run once per released panel version, before enabling installs.
 *
 *   node scripts/upload-panel-artifact.mjs \
 *     --file panel/beehive-panel-3.1.13.js \
 *     --key panel/beehive-panel-3.1.13.js \
 *     --bucket beehive-artifacts
 *
 * Uses `wrangler r2 object put`, so credentials come from the operator's
 * existing Wrangler login — nothing is stored by this script.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const file = arg("file", "panel/beehive-panel-3.1.13.js");
const key = arg("key", file);
const bucket = arg("bucket", "beehive-artifacts");

const buffer = await readFile(file);
const sha256 = createHash("sha256").update(buffer).digest("hex");
const gzipped = gzipSync(buffer, { level: 9 }).length;
const size = (await stat(file)).size;

console.log(`file     : ${file}`);
console.log(`bytes    : ${size.toLocaleString()}`);
console.log(`gzip     : ${gzipped.toLocaleString()} bytes (Workers script limit is 3 MB free / 10 MB paid)`);
console.log(`sha256   : ${sha256}`);
console.log(`r2 key   : ${bucket}/${key}`);
console.log("");

if (gzipped > 3 * 1024 * 1024) {
  console.warn("⚠️  Gzipped size exceeds the 3 MB free-plan Worker limit; deploying will require a paid plan.");
}

const child = spawn(
  "npx",
  ["wrangler", "r2", "object", "put", `${bucket}/${key}`, `--file=${file}`, "--content-type=application/javascript"],
  { stdio: "inherit" },
);
child.on("exit", (code) => {
  if (code === 0) {
    console.log("");
    console.log("Now update wrangler.toml if the key/hash changed:");
    console.log(`  PANEL_ARTIFACT_KEY = "${key}"`);
    console.log(`  PANEL_ARTIFACT_SHA256 = "${sha256}"`);
    console.log("and merge the same sha256 into migrations/0002_seed_plans.sql (panel_versions).");
  }
  process.exit(code ?? 1);
});
