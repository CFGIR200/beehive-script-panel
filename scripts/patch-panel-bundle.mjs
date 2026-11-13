#!/usr/bin/env node
/**
 * BEE.HIVE panel bundle codec + patch pipeline.
 *
 * The shipped panel bundle (panel/beehive-panel-*.js) is an obfuscated build:
 *
 *   L3  const factory=function(a,k){...}([],93);              // decoy / helper
 *   L4  const cart_box='…escaped…';;                          // obfuscated payload
 *   L5  const index=new Uint8Array([function(){return+84-17;}(),…]); // 16-byte XOR key
 *
 * The payload inside L4 is: JS source → UTF-8 bytes → XOR key (16 bytes, cycled)
 * → base64 → every base64 char XOR 93 → escaped into a single-quoted JS string.
 *
 * `panel/patches.json` carries the BEEHIVE-PATCH-1 (quota/expiry gating of
 * external raw configs) and BEEHIVE-PATCH-2 (external-config library:
 * bulk-apply + auto-include) definitions as exact find/replace pairs over the
 * DECODED payload. Applying them to a fresh upstream build reproduces the
 * approved patched bundle byte-for-byte (verified: sha256
 * 0e164a0a8f985e9024ebd1a7de059dedd0915e132638e93513290687eb963cd4).
 *
 * Modes:
 *   node scripts/patch-panel-bundle.mjs patch  --base <upstream.js> --out <out.js>
 *                                             [--expect-sha <hex>] [--only PATCH-1]
 *   node scripts/patch-panel-bundle.mjs check  <bundle.js>
 *   node scripts/patch-panel-bundle.mjs decode <bundle.js> [--out payload.js]
 *   node scripts/patch-panel-bundle.mjs encode --payload payload.js --base <bundle.js> --out <out.js>
 *   node scripts/patch-panel-bundle.mjs bump-version --base <bundle.js> --to <x.y.z> --out <out.js>
 *
 * `bump-version` (UPDRELEASE-1) derives a BEEHIVE release build from an already
 * patched bundle: it rewrites the payload header `/* Bee.Hive Panel · DCVERSION:x.y.z *​/`
 * comment, the panel's embedded `VERSION = "x.y.z"` config constant and the
 * bundle's own line-0 header to the new version, then re-encodes with the same
 * key. Every other byte stays identical, so the PATCH sentinels keep passing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCHES_FILE = path.join(ROOT, "panel", "patches.json");
const FREE_PLAN_LIMIT_BYTES = 3 * 1024 * 1024; // gzip ceiling for Workers free plan

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Extracts the 16-byte payload key from the `new Uint8Array([...])` loader line. */
export function extractKey(bundle) {
  const line = bundle.split("\n").find((l) => l.includes("new Uint8Array([") && l.includes("return+"));
  if (!line) fail("loader key line (new Uint8Array([...return+n-m...])) not found");
  const bytes = [...line.matchAll(/return\+(\d+)-(\d+);/g)].map((m) => Number(m[1]) - Number(m[2]));
  if (!bytes.length || bytes.some((b) => !(b >= 0 && b <= 255))) fail("loader key extraction failed");
  return Uint8Array.from(bytes);
}

/** Parses a JS single-quoted string literal body into raw bytes (\xHH, \\, \', \n, \r, \t, \0). */
function parseJsString(lit) {
  const out = [];
  let i = 0;
  while (i < lit.length) {
    const c = lit[i];
    if (c === 0x5c) {
      const nxt = lit[i + 1];
      if (nxt === undefined) fail("truncated escape in payload literal");
      if (nxt === 0x78) {
        const hex = String.fromCharCode(lit[i + 2], lit[i + 3]);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail(`bad \\x escape near offset ${i}`);
        out.push(parseInt(hex, 16));
        i += 4;
      } else if (nxt === 0x6e) { out.push(10); i += 2; }
      else if (nxt === 0x72) { out.push(13); i += 2; }
      else if (nxt === 0x74) { out.push(9); i += 2; }
      else if (nxt === 0x30) { out.push(0); i += 2; }
      else { out.push(nxt); i += 2; }
    } else {
      out.push(c);
      i += 1;
    }
  }
  return Uint8Array.from(out);
}

export function locatePayloadLine(bundle) {
  const lines = bundle.split("\n");
  const index = lines.findIndex((l) => l.includes("cart_box='"));
  if (index < 0) fail("payload line (cart_box='…') not found");
  return { lines, index };
}

export function decodeBundle(bundle) {
  const { lines, index } = locatePayloadLine(bundle);
  const line = lines[index];
  const startMarker = "cart_box='";
  const start = line.indexOf(startMarker) + startMarker.length;
  const end = line.lastIndexOf("'");
  if (!(start < end)) fail("cart_box literal boundaries not found");
  const chars = parseJsString(Buffer.from(line.slice(start, end), "latin1"));
  const b64 = Buffer.from(Array.from(chars, (c) => c ^ 93)).toString("latin1");
  const key = extractKey(bundle);
  const enc = Buffer.from(b64, "base64");
  const dec = Buffer.alloc(enc.length);
  for (let i = 0; i < enc.length; i += 1) dec[i] = enc[i] ^ key[i % key.length];
  return { payload: dec.toString("utf8"), key, lines, index };
}

/** Escapes payload bytes exactly like the vendor obfuscator. */
function escapeJsString(bytes) {
  let out = "";
  for (const c of bytes) {
    if (c === 0x5c) out += "\\\\";
    else if (c === 0x27) out += "\\'";
    else if (c >= 0x20 && c <= 0x7e) out += String.fromCharCode(c);
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export function encodePayload(payload, key) {
  const bytes = Buffer.from(payload, "utf8");
  const enc = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) enc[i] = bytes[i] ^ key[i % key.length];
  const b64 = enc.toString("base64");
  const xored = Array.from(Buffer.from(b64, "latin1"), (c) => c ^ 93);
  return `const cart_box='${escapeJsString(Uint8Array.from(xored))}';;`;
}

/** Replaces the payload line inside a bundle, keeping every other byte identical. */
export function spliceBundle(bundle, payloadLine) {
  const { lines, index } = locatePayloadLine(bundle);
  const next = [...lines];
  next[index] = payloadLine;
  return next.join("\n");
}

// ---------------------------------------------------------------------------
// patch application
// ---------------------------------------------------------------------------

function applyPairs(pairs, text, label) {
  let current = text;
  for (let i = 0; i < pairs.length; i += 1) {
    const { find, replace } = pairs[i];
    const hint = pairs[i].hint ? `${label} pair ${i + 1} (${pairs[i].hint})` : `${label} pair ${i + 1}`;
    if (typeof find !== "string" || typeof replace !== "string") fail(`${hint}: malformed pair`);
    const count = current.split(find).length - 1;
    if (count === 0) {
      fail(`${hint}: anchor not found — the upstream bundle has drifted and this patch must be re-ported (docs/UPDATES.md §4)`);
    }
    if (count > 1) fail(`${hint}: anchor matches ${count} times — patch definition is ambiguous`);
    // Function form: `$` sequences in `replace` ($&, $$, $' …) must be inserted
    // literally — the payload contains `$$` helpers that String.replace would mangle.
    current = current.replace(find, () => replace);
  }
  return current;
}

export function applyPatches(patchesDoc, payload, only) {
  let current = payload;
  const applied = [];
  for (const group of patchesDoc.patches) {
    if (only && !only.includes(group.id)) continue;
    current = applyPairs(group.pairs, current, group.id);
    applied.push(group.id);
  }
  if (!applied.length) fail(`no patch groups selected (requested: ${only?.join(", ") ?? "all"})`);
  return { payload: current, applied };
}

// ---------------------------------------------------------------------------
// modes
// ---------------------------------------------------------------------------

function report(out) {
  const sha = createHash("sha256").update(out).digest("hex");
  const gz = gzipSync(out, { level: 9 });
  console.log(`bundle bytes : ${out.length.toLocaleString("en-US")}`);
  console.log(`gzip -9 bytes: ${gz.length.toLocaleString("en-US")} (free-plan limit ${FREE_PLAN_LIMIT_BYTES.toLocaleString("en-US")})`);
  console.log(`sha256       : ${sha}`);
  if (gz.length >= FREE_PLAN_LIMIT_BYTES) {
    console.error("error: gzip size exceeds the Workers free-plan limit");
    process.exit(1);
  }
  return sha;
}

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) fail(`missing value for ${flag}`);
  return process.argv[i + 1];
}

const mode = process.argv[2];

/** Literal replacement helper: String.replace would mangle `$` sequences. */
function replaceOnce(text, find, replace, label) {
  const count = text.split(find).length - 1;
  if (count === 0) fail(`${label}: pattern not found`);
  if (count > 1) fail(`${label}: pattern matches ${count} times`);
  return text.replace(find, () => replace);
}

const VERSION_RE = /\d+\.\d+\.\d+/;

function bumpVersion() {
  const base = readFileSync(readArg("--base"), "utf8");
  const to = readArg("--to");
  if (!VERSION_RE.test(to) || to !== to.trim()) fail(`--to must be an x.y.z version string, got "${to}"`);
  const { payload, key } = decodeBundle(base);

  // 1) payload header comment: /* Bee.Hive Panel · DCVERSION:old */
  const payloadLines = payload.split("\n");
  const headerMatch = /^\/\* Bee\.Hive Panel · DCVERSION:(\d+\.\d+\.\d+) \*\/$/.exec(payloadLines[0] ?? "");
  if (!headerMatch) fail("payload header comment (/* Bee.Hive Panel · DCVERSION:x.y.z */) not found on line 1");
  const fromHeader = headerMatch[1];
  payloadLines[0] = `/* Bee.Hive Panel · DCVERSION:${to} */`;
  const bumpedPayload = payloadLines.join("\n");

  // 2) embedded panel config constant: VERSION = "old";
  const versionMatches = bumpedPayload.match(/\bVERSION\s*=\s*"\d+\.\d+\.\d+"/g) ?? [];
  if (versionMatches.length !== 1) {
    fail(`VERSION = "x.y.z" config constant matches ${versionMatches.length} times (expected exactly 1)`);
  }
  const fromConfig = /\d+\.\d+\.\d+/.exec(versionMatches[0])[0];
  const nextPayload = replaceOnce(bumpedPayload, versionMatches[0], `VERSION = "${to}"`, "config VERSION constant");

  // 3) re-encode with the vendor key and splice back into the wrapper.
  let out = spliceBundle(base, encodePayload(nextPayload, key));

  // 4) bundle line-0 header (must keep its BEEHIVE-PATCH marker for `check`).
  const lines = out.split("\n");
  const line0 = lines[0] ?? "";
  if (!line0.startsWith("/*")) fail("bundle line 0 is not a header comment");
  const dcCount = (line0.match(/DCVERSION:\d+\.\d+\.\d+/g) ?? []).length;
  if (dcCount !== 1) fail(`line-0 DCVERSION matches ${dcCount} times (expected exactly 1)`);
  const fromLine0 = /DCVERSION:(\d+\.\d+\.\d+)/.exec(line0)[1];
  lines[0] = line0.replace(/DCVERSION:\d+\.\d+\.\d+/, `DCVERSION:${to}`);
  if (!lines[0].includes("BEEHIVE-PATCH")) fail("line-0 header lost its BEEHIVE-PATCH marker");
  out = lines.join("\n");

  writeFileSync(readArg("--out"), out);
  console.error(`payload header  : DCVERSION ${fromHeader} -> ${to}`);
  console.error(`panel VERSION   : ${fromConfig} -> ${to}`);
  console.error(`bundle header   : DCVERSION ${fromLine0} -> ${to}`);
  const sha = report(out);
  const expected = process.argv.includes("--expect-sha") ? readArg("--expect-sha").toLowerCase() : null;
  if (expected && expected !== sha) {
    console.error(`error: sha mismatch (expected ${expected})`);
    process.exit(1);
  }
}

if (mode === "decode") {
  const bundle = readFileSync(process.argv[3] ?? fail("usage: decode <bundle.js>"), "utf8");
  const { payload } = decodeBundle(bundle);
  const out = process.argv.includes("--out") ? readArg("--out") : null;
  if (out) writeFileSync(out, payload);
  else process.stdout.write(payload);
  console.error(`payload: ${payload.length.toLocaleString("en-US")} chars${out ? ` → ${out}` : ""}`);
} else if (mode === "encode") {
  const payload = readFileSync(readArg("--payload"), "utf8");
  const bundle = readFileSync(readArg("--base"), "utf8");
  const key = extractKey(bundle);
  const out = spliceBundle(bundle, encodePayload(payload, key));
  writeFileSync(readArg("--out"), out);
  console.error("encoded bundle written");
  report(out);
} else if (mode === "patch") {
  const base = readFileSync(readArg("--base"), "utf8");
  const doc = JSON.parse(readFileSync(PATCHES_FILE, "utf8"));
  const only = process.argv.includes("--only") ? readArg("--only").split(",") : null;
  const { payload } = decodeBundle(base);
  const patched = applyPatches(doc, payload, only);
  const key = extractKey(base);
  let out = spliceBundle(base, encodePayload(patched.payload, key));
  // Declare the patch set in the bundle header so builds are identifiable at a glance.
  if (doc.header) {
    const lines = out.split("\n");
    if (lines[0]?.startsWith("/*")) lines[0] = doc.header;
    out = lines.join("\n");
  }
  writeFileSync(readArg("--out"), out);
  console.error(`applied: ${patched.applied.join(", ")}`);
  const sha = report(out);
  const expected = process.argv.includes("--expect-sha") ? readArg("--expect-sha").toLowerCase() : null;
  if (expected && expected !== sha) {
    console.error(`error: sha mismatch (expected ${expected})`);
    process.exit(1);
  }
} else if (mode === "check") {
  // Patch presence is probed via `sentinels` — stable text fragments that exist
  // only in the final, patched payload (derived from each group's changes and
  // stored in panel/patches.json). Find/replace blocks cannot be probed
  // directly: insertion pairs keep their anchors, and later patches rework the
  // text earlier patches introduced (PATCH-2 reworks the PATCH-1 gating site).
  const bundle = readFileSync(process.argv[3] ?? fail("usage: check <bundle.js>"), "utf8");
  const doc = JSON.parse(readFileSync(PATCHES_FILE, "utf8"));
  const { payload } = decodeBundle(bundle);
  let missing = 0;
  for (const group of doc.patches) {
    const sentinels = group.sentinels ?? [];
    if (!sentinels.length) fail(`${group.id}: no sentinels in ${PATCHES_FILE}`);
    const absent = sentinels.filter((s) => !payload.includes(s));
    console.log(`${group.id}: ${absent.length ? `MISSING ${absent.length}/${sentinels.length} sentinels` : "applied"}`);
    missing += absent.length;
  }
  const headerMarked = bundle.split("\n")[0]?.includes("BEEHIVE-PATCH") ?? false;
  console.log(`header patch marker: ${headerMarked ? "present" : "MISSING"}`);
  if (missing > 0 || !headerMarked) {
    console.error(`error: ${missing} sentinel(s) absent${headerMarked ? "" : " and header is unmarked"} — bundle is not a BEEHIVE-PATCH build`);
    process.exitCode = 1;
  } else {
    console.log("verdict: BEEHIVE-PATCH build (all groups present)");
  }
  report(bundle);
} else if (mode === "bump-version") {
  bumpVersion();
} else {
  fail("usage: patch-panel-bundle.mjs <patch|check|decode|encode|bump-version> …");
}
