import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie } from "./helpers.ts";

let cookie = "";

before(async () => {
  await seed();
  cookie = await userCookie("u_ayse");
});

after(async () => {
  await cleanup();
});

describe("PATCH /api/me (profile)", () => {
  it("renames the signed-in user and trims the name", async () => {
    const res = await req("/api/me", { method: "PATCH", cookie, body: { name: "  Ayşe Yılmaz " } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, "Ayşe Yılmaz");
    const session = await (await req("/api/auth/get-session", { cookie })).json();
    assert.equal(session.user.name, "Ayşe Yılmaz");
  });

  it("rejects empty and over-long names", async () => {
    for (const name of ["", "   ", "x".repeat(81)]) {
      const res = await req("/api/me", { method: "PATCH", cookie, body: { name } });
      assert.equal(res.status, 400, `name length ${name.length}`);
    }
  });

  it("does not let you change the e-mail through this endpoint", async () => {
    await req("/api/me", { method: "PATCH", cookie, body: { name: "Ayse", email: "evil@test.local" } });
    const session = await (await req("/api/auth/get-session", { cookie })).json();
    assert.equal(session.user.email, "ayse@test.local");
  });

  it("requires a session", async () => {
    assert.equal((await req("/api/me", { method: "PATCH", body: { name: "x" } })).status, 401);
  });
});
