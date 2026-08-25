import { and, eq, gt, isNull } from "drizzle-orm";
import { accountInvites } from "../db/schema";
import type { AppDB } from "../db/client";
import { getDb } from "../db/client";
import { ApiError } from "./http";
import { hashInviteToken, sha256Hex } from "./invite";

export async function hasPendingAccountInvite(db: AppDB, email: string): Promise<boolean> {
  const [row] = await getDb(db)
    .select({ id: accountInvites.id })
    .from(accountInvites)
    .where(and(eq(accountInvites.email, email), isNull(accountInvites.acceptedAt), gt(accountInvites.expiresAt, Date.now())));
  return Boolean(row);
}

export interface ValidAccountInvite {
  id: string;
  email: string;
}

export async function validateAccountInvite(db: AppDB, token: string): Promise<ValidAccountInvite> {
  if (!token) throw new ApiError(400, "Missing invite token");
  const tokenHash = await sha256Hex(token);
  const [row] = await getDb(db)
    .select({ id: accountInvites.id, email: accountInvites.email })
    .from(accountInvites)
    .where(and(eq(accountInvites.tokenHash, tokenHash), isNull(accountInvites.acceptedAt), gt(accountInvites.expiresAt, Date.now())));
  if (!row) throw new ApiError(410, "Invite link is invalid, expired or already used");
  return row;
}

export async function markAccountInviteAccepted(db: AppDB, inviteId: string): Promise<void> {
  await getDb(db).update(accountInvites).set({ acceptedAt: Date.now() }).where(eq(accountInvites.id, inviteId));
}

export { hashInviteToken };
