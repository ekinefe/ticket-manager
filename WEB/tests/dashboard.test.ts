import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie, env, PROJECT_ID } from "./helpers.ts";
const { getDb } = await import("../src/db/client.ts");
const { tasks } = await import("../src/db/schema.ts");

let superCookie = "";
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  const db = getDb(env.DB);
  const now = Date.now();
  // 2 recent + 3 old tickets (older than the 14-day default range); 1 old one is DONE.
  const rows = [
    { age: 1, status: "TODO" }, { age: 2, status: "DONE" },
    { age: 40, status: "TODO" }, { age: 50, status: "TODO" }, { age: 60, status: "DONE" },
  ];
  for (const [i, r] of rows.entries()) {
    const at = now - r.age * DAY;
    await db.insert(tasks).values({
      id: `t_dash_${i}`, projectId: PROJECT_ID, ticketId: `TST-${900 + i}`, title: `Dash ${i}`,
      status: r.status, assigneeId: "u_super", position: i, createdAt: at, updatedAt: at,
    });
  }
});

after(async () => {
  await cleanup();
});

describe("dashboard stats", () => {
  it("counts all tickets regardless of the Range filter", async () => {
    const res = await req("/api/dashboard/stats?days=7", { cookie: superCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.totalTickets, 5);
    assert.equal(data.myTickets.length, 5);
  });

  it("fills Projects Overview with real per-project counts", async () => {
    const res = await req("/api/dashboard/stats", { cookie: superCookie });
    const data = await res.json();
    const p = data.projectStats.find((x: any) => x.id === PROJECT_ID);
    assert.equal(p.total, 5);
    assert.equal(p.done, 2);
  });

  it("limits only the time chart to the Range", async () => {
    const res = await req("/api/dashboard/stats?days=7", { cookie: superCookie });
    const data = await res.json();
    const created = data.dailyStats.reduce((n: number, d: any) => n + d.created, 0);
    assert.equal(created, 2);
  });
});
