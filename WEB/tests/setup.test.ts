import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { req, cleanup } from "./helpers.ts";

// First-run bootstrap. These tests run in their own process with a fresh
// (unseeded) DB, so no super admin exists initially. helpers.ts cleanup only
// removes the seeded users; the admin created here is left in this throwaway DB.
describe("first-run setup", () => {
  after(() => cleanup());

  it("reports setup is needed when no super admin exists", async () => {
    const res = await req("/api/setup/status");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).needed, true);
  });

  it("validates the admin password length", async () => {
    const res = await req("/api/setup/complete", {
      method: "POST",
      body: { email: "short@test.local", name: "Short", password: "short" },
    });
    assert.equal(res.status, 400);
  });

  it("creates the initial super admin", async () => {
    const res = await req("/api/setup/complete", {
      method: "POST",
      body: { email: "boss@test.local", name: "Boss", password: "admin123!" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.role, "SUPER_ADMIN");
    assert.equal(data.email, "boss@test.local");

    // Setup is now closed.
    const status = await (await req("/api/setup/status")).json();
    assert.equal(status.needed, false);
  });

  it("rejects a second super admin after setup completes", async () => {
    const res = await req("/api/setup/complete", {
      method: "POST",
      body: { email: "other@test.local", name: "Other", password: "admin123!" },
    });
    assert.equal(res.status, 409);
  });
});
