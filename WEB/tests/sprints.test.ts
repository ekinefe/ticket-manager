import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  app, seed, cleanup, req, userCookie, PROJECT_ID, PREFIX,
} from "./helpers.ts";

let superCookie = "";
let adminCookie = "";
let memberCookie = "";
let outsiderCookie = "";

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  adminCookie = await userCookie("u_admin");
  memberCookie = await userCookie("u_ayse");
  outsiderCookie = await userCookie("u_zeynep");
});

after(async () => {
  await cleanup();
});

describe("sprints", () => {
  it("creates a default sprint when a project exists", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = data.sprints.map((s: any) => s.sprintId);
    assert.ok(ids.includes(`${PREFIX}-S1`), `expected ${PREFIX}-S1, got ${ids}`);
  });

  it("lets a project admin add a new sprint with the next ID", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/sprints`, {
      method: "POST", cookie: adminCookie, body: { name: "Sprint 2" },
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.sprintId, `${PREFIX}-S2`);
    assert.equal(data.name, "Sprint 2");
  });

  it("assigns a default name when none is provided", async () => {
    // Ensure a clean sequence: only the default S1 exists right now? No — the
    // previous test added S2. Use a fresh project via the super admin.
    const created = await req("/api/projects", {
      method: "POST", cookie: superCookie, body: { name: "Sprint Seed", prefix: "SPR" },
    });
    assert.equal(created.status, 201);
    const proj = await created.json();
    const add = await req(`/api/projects/${proj.id}/sprints`, {
      method: "POST", cookie: superCookie, body: {},
    });
    assert.equal(add.status, 201);
    const s = await add.json();
    assert.equal(s.sprintId, "SPR-S2");
    assert.equal(s.name, "Sprint 2");
  });

  it("lets a project admin rename a sprint", async () => {
    const list = await req(`/api/projects/${PROJECT_ID}`, { cookie: adminCookie });
    const sprints = (await list.json()).sprints;
    const target = sprints.find((s: any) => s.sprintId === `${PREFIX}-S1`);
    const res = await req(`/api/projects/${PROJECT_ID}/sprints/${target.id}`, {
      method: "PATCH", cookie: adminCookie, body: { name: "Kickoff" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.name, "Kickoff");
    assert.equal(data.sprintId, `${PREFIX}-S1`);
  });

  it("rejects renaming a sprint with an empty name", async () => {
    const list = await req(`/api/projects/${PROJECT_ID}`, { cookie: adminCookie });
    const target = (await list.json()).sprints[0];
    const res = await req(`/api/projects/${PROJECT_ID}/sprints/${target.id}`, {
      method: "PATCH", cookie: adminCookie, body: { name: "   " },
    });
    assert.equal(res.status, 400);
  });

  it("forbids a member from creating a sprint", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/sprints`, {
      method: "POST", cookie: memberCookie, body: { name: "Nope" },
    });
    assert.equal(res.status, 403);
  });

  it("forbids a non-member from listing the project", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}`, { cookie: outsiderCookie });
    assert.equal(res.status, 403);
  });

  it("prevents deleting the last remaining sprint", async () => {
    const created = await req("/api/projects", {
      method: "POST", cookie: superCookie, body: { name: "Solo Sprint", prefix: "SOL" },
    });
    const proj = await created.json();
    const list = await req(`/api/projects/${proj.id}`, { cookie: superCookie });
    const only = (await list.json()).sprints[0];
    const res = await req(`/api/projects/${proj.id}/sprints/${only.id}`, {
      method: "DELETE", cookie: superCookie,
    });
    assert.equal(res.status, 400);
    const after = await req(`/api/projects/${proj.id}`, { cookie: superCookie });
    assert.equal((await after.json()).sprints.length, 1);
  });

  it("allows deleting a sprint once more than one exists", async () => {
    const created = await req("/api/projects", {
      method: "POST", cookie: superCookie, body: { name: "Multi Sprint", prefix: "MUL" },
    });
    const proj = await created.json();
    await req(`/api/projects/${proj.id}/sprints`, {
      method: "POST", cookie: superCookie, body: { name: "Second" },
    });
    const list = await req(`/api/projects/${proj.id}`, { cookie: superCookie });
    const second = (await list.json()).sprints.find((s: any) => s.sprintId === "MUL-S2");
    const res = await req(`/api/projects/${proj.id}/sprints/${second.id}`, {
      method: "DELETE", cookie: superCookie,
    });
    assert.equal(res.status, 200);
    const after = await req(`/api/projects/${proj.id}`, { cookie: superCookie });
    assert.equal((await after.json()).sprints.length, 1);
  });

  it("includes sprints in global search by ID", async () => {
    const res = await req(`/api/search?q=${PREFIX}-S1`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = (data.sprints || []).map((s: any) => s.sprintId);
    assert.ok(ids.includes(`${PREFIX}-S1`), `expected sprint in search, got ${ids}`);
  });
});
