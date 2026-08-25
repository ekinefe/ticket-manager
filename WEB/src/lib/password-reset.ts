import { and, eq, isNull, gt } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { account, passwordResets, session, user } from "../db/schema";
import type { AppDB } from "../db/client";
import { getDb } from "../db/client";
import { ApiError } from "./http";
import { hashInviteToken } from "./invite";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function hasPendingPasswordReset(db: AppDB, userId: string): Promise<boolean> {
  const [row] = await getDb(db)
    .select({ id: passwordResets.id })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.userId, userId),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, Date.now())
      )
    );
  return Boolean(row);
}

export async function createPasswordReset(
  db: AppDB,
  userId: string
): Promise<{ token: string; expiresAt: number }> {
  // Invalidate any previous unused reset for this user.
  await getDb(db)
    .update(passwordResets)
    .set({ usedAt: Date.now() })
    .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const bin = String.fromCharCode(...bytes);
  const token = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const { tokenHash } = await hashInviteToken(token);
  const expiresAt = Date.now() + RESET_TTL_MS;
  await getDb(db).insert(passwordResets).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    createdAt: Date.now(),
  });
  return { token, expiresAt };
}

export async function validatePasswordReset(db: AppDB, token: string): Promise<string> {
  if (!token) throw new ApiError(400, "Missing reset token");
  const { tokenHash } = await hashInviteToken(token);
  const [row] = await getDb(db)
    .select({ userId: passwordResets.userId })
    .from(passwordResets)
    .where(
      and(
        eq(passwordResets.tokenHash, tokenHash),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, Date.now())
      )
    );
  if (!row) throw new ApiError(410, "Reset link is invalid, expired or already used");
  return row.userId;
}

/**
 * Sets a new password for the user's credential account and revokes all
 * their sessions (forced re-login everywhere).
 */
export async function applyPasswordReset(db: AppDB, userId: string, newPassword: string): Promise<void> {
  if (!newPassword || newPassword.length < 8) {
    throw new ApiError(400, "Password must be at least 8 characters");
  }
  const passwordHash = await hashPassword(newPassword);
  const updated = await getDb(db)
    .update(account)
    .set({ password: passwordHash, updatedAt: new Date() })
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .returning({ userId: account.userId });
  if (updated.length === 0) throw new ApiError(404, "No password credential found for this account");

  await getDb(db).delete(session).where(eq(session.userId, userId));

  // Consume the token.
  await getDb(db)
    .update(passwordResets)
    .set({ usedAt: Date.now() })
    .where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
}

export async function findUserIdByEmail(db: AppDB, email: string): Promise<string | null> {
  const [row] = await getDb(db)
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  return row?.id ?? null;
}
