import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";

// TM_DB_FILE must be set BEFORE the server module is imported; the module
// opens the database at import time.
const dir = mkdtempSync(join(tmpdir(), "tm-test-"));
process.env.TM_DB_FILE = join(dir, "test.db");
process.env.MAIL_TRANSPORT = "file";

const { app, env } = await import("../server/main.ts");
const { user, account, projectMembers, projects, sprints } = await import("../src/db/schema.ts");
const { getDb } = await import("../src/db/client.ts");

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: "SUPER_ADMIN" | "ADMIN" | "USER";
}

const USERS: TestUser[] = [
  { id: "u_super", email: "super@test.local", password: "admin123!", role: "SUPER_ADMIN" },
  { id: "u_admin", email: "admin@test.local", password: "admin123!", role: "ADMIN" },
  { id: "u_ayse", email: "ayse@test.local", password: "member123!", role: "USER" },
  { id: "u_mehmet", email: "mehmet@test.local", password: "member123!", role: "USER" },
  { id: "u_zeynep", email: "zeynep@test.local", password: "member123!", role: "USER" },
];

export const PROJECT_ID = "prj_test";
export const PREFIX = "TST";

export async function seed(): Promise<void> {
  const db = getDb(env.DB);
  const now = new Date();
  for (const u of USERS) {
    await db.insert(user).values({
      id: u.id, name: u.email.split("@")[0], email: u.email,
      emailVerified: false, role: u.role, createdAt: now, updatedAt: now,
    });
    await db.insert(account).values({
      id: `acc_${u.id}`, accountId: u.id, providerId: "credential",
      // Better Auth v1.7 requires issuer "local:credential" for sign-in.
      issuer: "local:credential",
      userId: u.id, password: await hashPassword(u.password), createdAt: now, updatedAt: now,
    });
  }
  await db.insert(projects).values({
    id: PROJECT_ID, name: "Test Project", prefix: PREFIX,
    currentTicketSequence: 0, createdAt: Date.now(),
  });
  // Every project starts with a default first sprint (PREFIX-S1).
  await db.insert(sprints).values({
    id: "spr_default", projectId: PROJECT_ID, sprintId: `${PREFIX}-S1`,
    name: "Sprint 1", createdAt: Date.now(),
  });
  // ayse and mehmet are project members; zeynep is not.
  for (const [userId, role] of [
    ["u_super", "ADMIN"], ["u_admin", "ADMIN"], ["u_ayse", "MEMBER"], ["u_mehmet", "MEMBER"],
  ] as const) {
    await db.insert(projectMembers).values({ projectId: PROJECT_ID, userId, role });
  }
}

export { app, env, USERS };

export async function signIn(email: string, password: string): Promise<string> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  return cookies.join("; ");
}

export async function userCookie(id: string): Promise<string> {
  const u = USERS.find((x) => x.id === id)!;
  return signIn(u.email, u.password);
}

export function req(
  path: string,
  { method = "GET", cookie, body, form }: {
    method?: string;
    cookie?: string;
    body?: unknown;
    form?: FormData;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

export async function cleanup(): Promise<void> {
  // Remove rows created by tests (users cascade everything else).
  const db = getDb(env.DB);
  for (const u of USERS) {
    await db.delete(user).where(eq(user.id, u.id));
  }
}
