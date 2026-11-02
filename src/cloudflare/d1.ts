/** D1 database lifecycle, backup export and restore import. */

import { CloudflareClient } from "./client";
import { AppError, messages } from "../utils/errors";

export interface D1DatabaseInfo {
  uuid: string;
  name: string;
  created_at?: string;
  version?: string;
  num_tables?: number;
  file_size?: number;
}

export interface D1QueryResult {
  results: Array<Record<string, unknown>>;
  success: boolean;
  meta?: Record<string, unknown>;
}

export async function listDatabases(client: CloudflareClient, accountId: string): Promise<D1DatabaseInfo[]> {
  return client.paginate<D1DatabaseInfo>(`/accounts/${accountId}/d1/database`, 5);
}

export async function findDatabaseByName(
  client: CloudflareClient,
  accountId: string,
  name: string,
): Promise<D1DatabaseInfo | null> {
  const databases = await listDatabases(client, accountId);
  return databases.find((database) => database.name === name) ?? null;
}

/** POST /accounts/{id}/d1/database */
export async function createDatabase(
  client: CloudflareClient,
  accountId: string,
  name: string,
): Promise<D1DatabaseInfo> {
  const envelope = await client.request<D1DatabaseInfo>(`/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: { name },
    retries: 1,
  });
  const result = envelope.result;
  if (!result?.uuid) throw new AppError("CF_ERROR", messages.cfError, { detail: "d1 create returned no uuid" });
  return result;
}

/** Idempotent create: reuses an existing database with the same name. */
export async function ensureDatabase(
  client: CloudflareClient,
  accountId: string,
  name: string,
): Promise<{ database: D1DatabaseInfo; created: boolean }> {
  const existing = await findDatabaseByName(client, accountId, name);
  if (existing) return { database: existing, created: false };
  const created = await createDatabase(client, accountId, name);
  return { database: created, created: true };
}

export async function deleteDatabase(client: CloudflareClient, accountId: string, uuid: string): Promise<boolean> {
  try {
    await client.request<null>(`/accounts/${accountId}/d1/database/${uuid}`, { method: "DELETE", retries: 1 });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === "CF_NOT_FOUND") return false;
    throw error;
  }
}

/** POST /accounts/{id}/d1/database/{uuid}/query — used for health probing only. */
export async function query(
  client: CloudflareClient,
  accountId: string,
  uuid: string,
  sql: string,
  params: unknown[] = [],
): Promise<D1QueryResult[]> {
  const envelope = await client.request<D1QueryResult[]>(`/accounts/${accountId}/d1/database/${uuid}/query`, {
    method: "POST",
    body: { sql, params },
    retries: 1,
  });
  return envelope.result ?? [];
}

/**
 * Backup via the documented D1 export API.
 *
 * The API is asynchronous: the first POST returns a bookmark that must be
 * polled. `output_format: "polling"` makes Cloudflare report progress through
 * the same call until `status === "complete"` and a signed download URL exists.
 */
export interface ExportProgress {
  status?: string;
  at_bookmark?: string;
  signed_url?: string;
  messages?: string[];
  error?: string;
}

export async function exportDatabase(
  client: CloudflareClient,
  accountId: string,
  uuid: string,
  options: { maxPolls?: number; delayMs?: number } = {},
): Promise<string> {
  const maxPolls = options.maxPolls ?? 20;
  const delayMs = options.delayMs ?? 1500;

  let envelope = await client.request<ExportProgress>(`/accounts/${accountId}/d1/database/${uuid}/export`, {
    method: "POST",
    body: { output_format: "polling" },
    retries: 0,
  });

  for (let poll = 0; poll < maxPolls; poll += 1) {
    const progress = envelope.result;
    if (progress?.signed_url) return progress.signed_url;
    if (progress?.error) {
      throw new AppError("CF_ERROR", "تهیهٔ پشتیبان از پایگاه داده ناموفق بود.", { detail: progress.error });
    }
    if (!progress?.at_bookmark) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    envelope = await client.request<ExportProgress>(`/accounts/${accountId}/d1/database/${uuid}/export`, {
      method: "POST",
      body: { output_format: "polling", current_bookmark: progress.at_bookmark },
      retries: 0,
    });
  }
  throw new AppError("CF_TIMEOUT", "تهیهٔ پشتیبان زمان‌بر شد؛ لطفاً بعداً تلاش کنید.", {
    detail: "d1 export did not produce a signed url",
  });
}

/** Downloads an exported dump (the signed URL is already authorisation). */
export async function downloadExport(signedUrl: string): Promise<string> {
  const response = await fetch(signedUrl, { method: "GET" });
  if (!response.ok) {
    throw new AppError("CF_ERROR", "دریافت فایل پشتیبان ناموفق بود.", { detail: `status ${response.status}` });
  }
  return response.text();
}

/**
 * Restore via the documented import API: init → upload to the signed URL →
 * ingest → poll. Import replaces the database contents (`action: "init"`).
 */
export async function importDatabase(
  client: CloudflareClient,
  accountId: string,
  uuid: string,
  sql: string,
  options: { maxPolls?: number; delayMs?: number } = {},
): Promise<void> {
  const bytes = new TextEncoder().encode(sql);
  const etag = await md5Hex(bytes);
  const filename = `restore-${Date.now()}.sql`;

  const init = await client.request<{ upload_url?: string; url?: string }>(
    `/accounts/${accountId}/d1/database/${uuid}/import`,
    { method: "POST", body: { action: "init", etag }, retries: 0 },
  );
  const uploadUrl = init.result?.upload_url ?? init.result?.url;
  if (!uploadUrl) {
    throw new AppError("CF_ERROR", "آماده‌سازی بازیابی ناموفق بود.", { detail: "import init returned no upload url" });
  }

  const upload = await fetch(uploadUrl, {
    method: "PUT",
    body: bytes,
    headers: { "Content-Type": "application/sql" },
  });
  if (!upload.ok) {
    throw new AppError("CF_ERROR", "بارگذاری فایل پشتیبان ناموفق بود.", { detail: `upload status ${upload.status}` });
  }

  await client.request<unknown>(`/accounts/${accountId}/d1/database/${uuid}/import`, {
    method: "POST",
    body: { action: "ingest", etag, filename },
    retries: 0,
  });

  const maxPolls = options.maxPolls ?? 20;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const envelope = await client.request<{ status?: string; messages?: string[]; error?: string }>(
      `/accounts/${accountId}/d1/database/${uuid}/import`,
      { method: "POST", body: { action: "poll", current_bookmark: filename }, retries: 0 },
    );
    const status = envelope.result?.status;
    if (status === "complete" || status === "completed") return;
    if (envelope.result?.error) {
      throw new AppError("CF_ERROR", "بازیابی پایگاه داده ناموفق بود.", { detail: envelope.result.error });
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1500));
  }
  throw new AppError("CF_TIMEOUT", "بازیابی زمان‌بر شد؛ وضعیت پایگاه داده را بررسی کنید.", {
    detail: "d1 import polling timed out",
  });
}

/**
 * MD5 of the uploaded dump — required by the D1 import API's `etag` field.
 * Web Crypto does not offer MD5, so this is a small, dependency-free
 * implementation used *only* for the etag (never for security decisions).
 */
export function md5Hex(input: Uint8Array): string {
  return md5(input)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function md5(data: Uint8Array): number[] {
  const length = data.length;
  const bitLength = length * 8;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(data);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = (a + f + (K[i] ?? 0) + (words[g] ?? 0)) >>> 0;
      b = (b + (((sum << (S[i] ?? 0)) | (sum >>> (32 - (S[i] ?? 0)))) >>> 0)) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out: number[] = [];
  for (const value of [a0, b0, c0, d0]) {
    out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }
  return out;
}
