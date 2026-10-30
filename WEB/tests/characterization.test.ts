// Pins the CURRENT behaviour of routes that had little or no coverage, as a
// safety net for the domain refactor (DOC/adr/0001-modular-domains.md).
// If one of these fails after a move, behaviour changed: fix the move.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie, PROJECT_ID } from "./helpers.ts";

const { env } = await import("../server/main.ts");
const { getDb } = await import("../src/db/client.ts");
const { notifications } = await import("../src/db/schema.ts");

let superCookie = "";
let adminCookie = "";
let memberCookie = "";
let otherMemberCookie = "";
let outsiderCookie = "";

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  adminCookie = await userCookie("u_admin");
  memberCookie = await userCookie("u_ayse");
  otherMemberCookie = await userCookie("u_mehmet");
  outsiderCookie = await userCookie("u_zeynep");
});

after(async () => {
  await cleanup();
});

async function createTask(cookie: string, title = "Characterization ticket") {
  const res = await req(`/api/projects/${PROJECT_ID}/tasks`, { method: "POST", cookie, body: { title } });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ id: string; status: string }>;
}

describe("unauthenticated access", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/projects"],
    ["GET", `/api/projects/${PROJECT_ID}`],
    ["GET", `/api/projects/${PROJECT_ID}/tasks`],
    ["POST", `/api/projects/${PROJECT_ID}/tasks`],
    ["GET", "/api/my-tickets"],
    ["GET", "/api/notifications"],
    ["GET", "/api/notifications/unread-count"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/admin/settings"],
    ["GET", "/api/reports"],
    ["GET", "/api/dashboard/stats"],
    ["GET", `/api/projects/${PROJECT_ID}/export`],
  ];
  for (const [method, path] of routes) {
    it(`${method} ${path} is rejected with 401`, async () => {
      const res = await req(path, { method, body: method === "POST" ? {} : undefined });
      assert.equal(res.status, 401);
    });
  }
});

describe("notifications", () => {
  const ids = ["n_char_1", "n_char_2", "n_char_3"];

  before(async () => {
    const db = getDb(env.DB);
    for (const id of ids) {
      await db.insert(notifications).values({
        id, userId: "u_ayse", actorId: "u_admin", type: "COMMENT_ADDED",
        projectId: PROJECT_ID, message: `msg ${id}`, createdAt: Date.now(),
      });
    }
  });

  it("lists only the caller's notifications with a total", async () => {
    const res = await req("/api/notifications", { cookie: memberCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.total, 3);
    assert.equal(data.notifications.length, 3);
    assert.equal(data.notifications[0].actorName, "admin");

    const other = await (await req("/api/notifications", { cookie: otherMemberCookie })).json();
    assert.equal(other.total, 0);
  });

  it("respects limit", async () => {
    const data = await (await req("/api/notifications?limit=1", { cookie: memberCookie })).json();
    assert.equal(data.notifications.length, 1);
    assert.equal(data.total, 3);
  });

  it("counts unread, marks one read and unread again", async () => {
    const count = async () => (await (await req("/api/notifications/unread-count", { cookie: memberCookie })).json()).count;
    assert.equal(await count(), 3);
    assert.equal((await req("/api/notifications/n_char_1/read", { method: "PATCH", cookie: memberCookie })).status, 200);
    assert.equal(await count(), 2);
    assert.equal((await req("/api/notifications/n_char_1/unread", { method: "PATCH", cookie: memberCookie })).status, 200);
    assert.equal(await count(), 3);
  });

  it("cannot touch another user's notification (silently no-ops)", async () => {
    const res = await req("/api/notifications/n_char_2/read", { method: "PATCH", cookie: otherMemberCookie });
    assert.equal(res.status, 200);
    const del = await req("/api/notifications/n_char_2", { method: "DELETE", cookie: otherMemberCookie });
    assert.equal(del.status, 200);
    const data = await (await req("/api/notifications", { cookie: memberCookie })).json();
    assert.equal(data.total, 3);
    assert.equal(data.notifications.find((n: any) => n.id === "n_char_2").readAt, null);
  });

  it("marks all read, then deletes one", async () => {
    assert.equal((await req("/api/notifications/read-all", { method: "PATCH", cookie: memberCookie })).status, 200);
    const unread = await (await req("/api/notifications/unread-count", { cookie: memberCookie })).json();
    assert.equal(unread.count, 0);
    assert.equal((await req("/api/notifications/n_char_3", { method: "DELETE", cookie: memberCookie })).status, 200);
    const data = await (await req("/api/notifications", { cookie: memberCookie })).json();
    assert.equal(data.total, 2);
  });
});

describe("admin settings and cron", () => {
  it("only a super admin can read or change settings", async () => {
    for (const cookie of [adminCookie, memberCookie]) {
      assert.equal((await req("/api/admin/settings", { cookie })).status, 403);
      assert.equal((await req("/api/admin/settings", { method: "PATCH", cookie, body: {} })).status, 403);
    }
    assert.equal((await req("/api/admin/settings", { cookie: superCookie })).status, 200);
  });

  it("stores only known keys and returns them", async () => {
    const patch = await req("/api/admin/settings", {
      method: "PATCH", cookie: superCookie, body: { mail_from: "x@test.local", not_a_setting: "nope" },
    });
    assert.equal(patch.status, 200);
    const data = await (await req("/api/admin/settings", { cookie: superCookie })).json();
    assert.equal(data.not_a_setting, undefined);
    assert.equal(data.mail_from, "x@test.local");
  });

  it("cron endpoint is super admin only and rejects unknown jobs", async () => {
    assert.equal((await req("/api/dev/cron/daily", { method: "POST", cookie: adminCookie })).status, 403);
    assert.equal((await req("/api/dev/cron/nope", { method: "POST", cookie: superCookie })).status, 404);
  });
});

describe("ticket update and delete permissions", () => {
  it("a member can edit their own ticket", async () => {
    const t = await createTask(memberCookie);
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, {
      method: "PATCH", cookie: memberCookie, body: { title: "Renamed by owner" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).title, "Renamed by owner");
  });

  it("an outsider cannot update or delete a ticket", async () => {
    const t = await createTask(memberCookie);
    const patch = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, {
      method: "PATCH", cookie: outsiderCookie, body: { title: "hijack" },
    });
    assert.ok([403, 404].includes(patch.status), `got ${patch.status}`);
    const del = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, { method: "DELETE", cookie: outsiderCookie });
    assert.ok([403, 404].includes(del.status), `got ${del.status}`);
  });

  it("delete needs DELETE_TICKET; a project admin can, then it is gone", async () => {
    const t = await createTask(memberCookie);
    const denied = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, { method: "DELETE", cookie: memberCookie });
    assert.equal(denied.status, 403);
    const ok = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, { method: "DELETE", cookie: adminCookie });
    assert.equal(ok.status, 200);
    const again = await req(`/api/projects/${PROJECT_ID}/tasks/${t.id}`, { method: "DELETE", cookie: adminCookie });
    assert.equal(again.status, 404);
  });
});

describe("project update and delete", () => {
  it("project admin renames; members cannot", async () => {
    const ok = await req(`/api/projects/${PROJECT_ID}`, { method: "PATCH", cookie: adminCookie, body: { name: "Renamed" } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).name, "Renamed");
    const denied = await req(`/api/projects/${PROJECT_ID}`, { method: "PATCH", cookie: memberCookie, body: { name: "x" } });
    assert.equal(denied.status, 403);
  });

  it("validates the prefix and requires something to update", async () => {
    const bad = await req(`/api/projects/${PROJECT_ID}`, { method: "PATCH", cookie: adminCookie, body: { prefix: "a" } });
    assert.equal(bad.status, 400);
    const empty = await req(`/api/projects/${PROJECT_ID}`, { method: "PATCH", cookie: adminCookie, body: {} });
    assert.equal(empty.status, 400);
  });

  it("default assignee must be a project member", async () => {
    const bad = await req(`/api/projects/${PROJECT_ID}`, {
      method: "PATCH", cookie: adminCookie, body: { defaultAssigneeId: "u_zeynep" },
    });
    assert.equal(bad.status, 400);
  });

  it("only a super admin can delete a project", async () => {
    assert.equal((await req(`/api/projects/${PROJECT_ID}`, { method: "DELETE", cookie: adminCookie })).status, 403);
    assert.equal((await req("/api/projects/does-not-exist", { method: "DELETE", cookie: superCookie })).status, 404);
  });
});

describe("visibility", () => {
  it("an outsider sees no tickets of the project", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/tasks`, { cookie: outsiderCookie });
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
    const mine = await (await req("/api/projects", { cookie: outsiderCookie })).json();
    assert.equal(mine.length, 0);
  });
});
