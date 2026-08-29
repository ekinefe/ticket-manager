import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { req, seed, cleanup, signIn, env } from "./helpers.ts";
import { getDb } from "../src/db/client.ts";
import { session } from "../src/db/schema.ts";

describe("change password", () => {
  before(() => seed());
  after(() => cleanup());

  it("rejects self-change with the wrong current password", async () => {
    const cookie = await signIn("super@test.local", "admin123!");
    const res = await req("/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: "nope", newPassword: "newpass123!" },
    });
    assert.equal(res.status, 400);
  });

  it("rejects a new password shorter than 8 chars", async () => {
    const cookie = await signIn("super@test.local", "admin123!");
    const res = await req("/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: "admin123!", newPassword: "short" },
    });
    assert.equal(res.status, 400);
  });

  it("requires authentication", async () => {
    const res = await req("/api/auth/change-password", {
      method: "POST",
      body: { currentPassword: "admin123!", newPassword: "newpass123!" },
    });
    assert.equal(res.status, 401);
  });

  it("changes the user's own password and the new one works", async () => {
    const cookie = await signIn("super@test.local", "admin123!");
    const res = await req("/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: "admin123!", newPassword: "changed123!" },
    });
    assert.equal(res.status, 200);

    // Old password must no longer work.
    const oldRes = await req("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "super@test.local", password: "admin123!" },
    });
    assert.equal(oldRes.status, 401);

    // New password works.
    const newRes = await req("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "super@test.local", password: "changed123!" },
    });
    assert.equal(newRes.status, 200);
  });

  it("lets a super admin set another user's password (revokes their session)", async () => {
    const superCookie = await req("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "super@test.local", password: "changed123!" },
    }).then((r) => r.headers.getSetCookie()[0].split(";")[0]);

    const res = await req("/api/admin/users/u_ayse/password", {
      method: "POST",
      cookie: superCookie,
      body: { password: "brandnew123!" },
    });
    assert.equal(res.status, 200);

    // ayse's old password is gone...
    const oldRes = await req("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "ayse@test.local", password: "member123!" },
    });
    assert.equal(oldRes.status, 401);

    // ...and all her sessions were revoked (rows removed from the DB).
    const remaining = await getDb(env.DB)
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, "u_ayse"));
    assert.equal(remaining.length, 0);
  });

  it("short password is rejected by admin set", async () => {
    const superCookie = await req("/api/auth/sign-in/email", {
      method: "POST",
      body: { email: "super@test.local", password: "changed123!" },
    }).then((r) => r.headers.getSetCookie()[0].split(";")[0]);
    const res = await req("/api/admin/users/u_mehmet/password", {
      method: "POST",
      cookie: superCookie,
      body: { password: "x" },
    });
    assert.equal(res.status, 400);
  });

  it("blocks non-super-admins from setting a user's password", async () => {
    const adminCookie = await signIn("admin@test.local", "admin123!");
    const res = await req("/api/admin/users/u_zeynep/password", {
      method: "POST",
      cookie: adminCookie,
      body: { password: "whatever123!" },
    });
    assert.equal(res.status, 403);
  });
});
