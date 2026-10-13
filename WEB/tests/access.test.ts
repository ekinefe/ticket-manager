import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie, PROJECT_ID } from "./helpers.ts";

let superCookie = "";
let adminCookie = "";

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  adminCookie = await userCookie("u_admin");
});

after(async () => {
  await cleanup();
});

describe("access overview + audit log", () => {
  it("is super-admin only", async () => {
    assert.equal((await req("/api/admin/access", { cookie: adminCookie })).status, 403);
    assert.equal((await req("/api/admin/audit", { cookie: adminCookie })).status, 403);
  });

  it("returns a users x projects matrix with permissions", async () => {
    const res = await req("/api/admin/access", { cookie: superCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.users.length > 0 && data.projects.length > 0);
    const m = data.memberships.find((x: any) => x.projectId === PROJECT_ID && x.role === "ADMIN");
    if (m) assert.ok(m.permissions.length >= 7);
  });

  it("records role / permission changes, and skips unchanged permission saves", async () => {
    const userId = "u_zeynep";
    const add = await req(`/api/admin/users/${userId}/projects`, { method: "POST", cookie: superCookie, body: { projectId: PROJECT_ID, role: "MEMBER" } });
    assert.equal(add.status, 200);
    const perms = ["VIEW_ALL_TICKETS", "CREATE_TICKET", "DELETE_TICKET"];
    const url = `/api/admin/users/${userId}/projects/${PROJECT_ID}/permissions`;
    await req(url, { method: "PATCH", cookie: superCookie, body: { permissions: perms } });
    await req(url, { method: "PATCH", cookie: superCookie, body: { permissions: perms } }); // unchanged
    const promote = await req(`/api/admin/users/${userId}/projects`, { method: "POST", cookie: superCookie, body: { projectId: PROJECT_ID, role: "ADMIN" } });
    assert.equal(promote.status, 200);
    await req(`/api/admin/users/${userId}/projects/${PROJECT_ID}`, { method: "DELETE", cookie: superCookie });

    const log = await (await req("/api/admin/audit", { cookie: superCookie })).json();
    const mine = log.filter((e: any) => e.targetUserId === userId).map((e: any) => e.action);
    assert.equal(mine.filter((a: string) => a === "PERMISSIONS_CHANGED").length, 1);
    assert.ok(mine.includes("MEMBER_ADDED") || mine.includes("MEMBER_ROLE_CHANGED"));
    assert.ok(mine.includes("MEMBER_ROLE_CHANGED"));
    assert.ok(mine.includes("MEMBER_REMOVED"));
    assert.equal(log[0].actorName.length > 0, true);
  });
});
