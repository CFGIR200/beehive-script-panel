#!/usr/bin/env node
/**
 * Builds the deployable release archive.
 *
 *   node scripts/build-release.mjs
 *
 * Produces dist/BEEHIVE-BOT-PRODUCTION-v1.0.0.zip containing the source, the
 * migrations, the docs, the scripts and the panel artifact — but never any
 * node_modules, .dev.vars, wrangler cache or secret file.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const outDir = path.join(root, "dist");
const staging = path.join(outDir, `beehive-bot-${version}`);
// The archive is written to the project root on purpose: build output
// directories are disposable, the release artifact must survive a clean.
const zipPath = path.join(root, `BEEHIVE-BOT-PRODUCTION-v${version}.zip`);

const INCLUDE = ["src", "migrations", "tests", "docs", "scripts", "panel"];
const FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "wrangler.toml",
  "vitest.config.ts",
  "README.md",
  ".gitignore",
  ".dev.vars.example",
];

await mkdir(outDir, { recursive: true });
await cp(staging, staging, { recursive: true, force: true }).catch(() => {});
await mkdir(staging, { recursive: true });

for (const dir of INCLUDE) {
  await cp(path.join(root, dir), path.join(staging, dir), { recursive: true });
}
for (const file of FILES) {
  try {
    await cp(path.join(root, file), path.join(staging, file));
  } catch {
    console.warn(`skip missing file: ${file}`);
  }
}

// A release must never contain secrets: `.dev.vars`, `.env`, `.env.*`
// (except the committed *.example templates) and the wrangler cache.
const SECRET_EXACT = new Set([".dev.vars", ".env", ".dev.vars.local"]);
const isForbidden = (entry) => {
  const rel = String(entry).split(path.sep).join("/");
  const segments = rel.split("/");
  if (segments.some((segment) => segment === ".wrangler" || segment === "node_modules")) return true;
  const base = segments[segments.length - 1];
  if (SECRET_EXACT.has(base)) return true;
  if (base.startsWith(".env.") && !base.endsWith(".example")) return true;
  return false;
};
const found = (await readdir(staging, { recursive: true })).filter(isForbidden);
if (found.length) {
  console.error("Refusing to package: secret or cache files present:", found);
  process.exit(1);
}
// Belt and braces: no file in the archive may contain a live-looking token.
// Matches of obviously synthetic fixtures (used by the redaction tests) are
// ignored on purpose: they are literals such as "123456789:AAFakeToken...".
const tokenPattern = /(cfut_[A-Za-z0-9_-]{8,}|\b\d{8,12}:AA[A-Za-z0-9_-]{30,})/;
const SYNTHETIC = /fake|dummy|redact|sample|placeholder|example|test-token/i;
for (const entry of await readdir(staging, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const full = path.join(entry.path ?? staging, entry.name);
  const text = await readFile(full, "utf8").catch(() => "");
  if (!text) continue;
  for (const match of text.match(tokenPattern) ?? []) {
    if (SYNTHETIC.test(match)) continue;
    console.error(`Refusing to package: possible credential in ${path.relative(staging, full)} (${match.slice(0, 6)}…)`);
    process.exit(1);
  }
}

// Checksums for every file in the archive.
const entries = await readdir(staging, { recursive: true, withFileTypes: true });
const sums = [];
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const full = path.join(entry.path ?? staging, entry.name);
  const buffer = await readFile(full);
  sums.push(`${createHash("sha256").update(buffer).digest("hex")}  ${path.relative(staging, full)}`);
}
await writeFile(path.join(staging, "CHECKSUMS.sha256"), `${sums.sort().join("\n")}\n`);

const zip = spawn("zip", ["-r", "-q", zipPath, path.basename(staging)], { cwd: outDir, stdio: "inherit" });
zip.on("exit", async (code) => {
  if (code !== 0) {
    console.error("zip failed");
    process.exit(code ?? 1);
  }
  const info = await stat(zipPath);
  console.log(`release: ${zipPath}`);
  console.log(`size   : ${(info.size / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`files  : ${sums.length}`);
});
