/** Token verification and account discovery. */

import { CloudflareClient } from "./client";
import { AppError, messages } from "../utils/errors";

export interface VerifiedToken {
  id: string;
  status: "active" | "expired" | "disabled" | string;
  notBefore?: string | null;
  expiresOn?: string | null;
}

export interface CloudflareAccountInfo {
  id: string;
  name: string;
  type?: string;
}

/** GET /user/tokens/verify — the only authoritative check for token validity. */
export async function verifyToken(client: CloudflareClient): Promise<VerifiedToken> {
  const envelope = await client.request<VerifiedToken>("/user/tokens/verify", { retries: 1 });
  const result = envelope.result;
  if (!result || typeof result !== "object" || !("status" in result)) {
    throw new AppError("CF_ERROR", messages.cfError, { detail: "verify returned unexpected payload" });
  }
  if (result.status !== "active") {
    throw new AppError("CF_UNAUTHORIZED", messages.cfUnauthorized, { detail: `token status=${result.status}` });
  }
  return result;
}

/** GET /accounts — the accounts this token can act on. */
export async function listAccounts(client: CloudflareClient): Promise<CloudflareAccountInfo[]> {
  const accounts = await client.paginate<CloudflareAccountInfo>("/accounts", 3);
  return accounts
    .filter((account) => typeof account?.id === "string" && typeof account?.name === "string")
    .map((account) => ({ id: account.id, name: account.name, type: account.type }));
}

export async function getAccount(client: CloudflareClient, accountId: string): Promise<CloudflareAccountInfo> {
  const envelope = await client.request<CloudflareAccountInfo>(`/accounts/${accountId}`);
  return envelope.result;
}
