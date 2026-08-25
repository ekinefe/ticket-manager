import { and, eq, isNull, gt } from "drizzle-orm";
import { invitations } from "../db/schema";
import type { AppDB } from "../db/client";
import { getDb } from "../db/client";
import { ApiError } from "./http";

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function generateInviteToken(): { token: string; tokenHash: string; expiresAt: number } {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    token: toBase64Url(bytes),
    tokenHash: "",
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashInviteToken(token: string): Promise<{ tokenHash: string; expiresAt: number }> {
  return {
    tokenHash: await sha256Hex(token),
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
}

export interface ValidInvitation {
  id: string;
  projectId: string;
  email: string;
  invitedRole: "ADMIN" | "MEMBER";
}

export async function validateInvitation(db: AppDB, token: string): Promise<ValidInvitation> {
  if (!token) throw new ApiError(400, "Missing invite token");
  const tokenHash = await sha256Hex(token);
  const [row] = await getDb(db)
    .select({
      id: invitations.id,
      projectId: invitations.projectId,
      email: invitations.email,
      invitedRole: invitations.invitedRole,
    })
    .from(invitations)
    .where(and(eq(invitations.tokenHash, tokenHash), isNull(invitations.acceptedAt), gt(invitations.expiresAt, Date.now())));

  if (!row) throw new ApiError(410, "Invite link is invalid, expired or already used");
  return row;
}

export async function markInvitationAccepted(db: AppDB, invitationId: string): Promise<void> {
  await getDb(db).update(invitations).set({ acceptedAt: Date.now() }).where(eq(invitations.id, invitationId));
}
