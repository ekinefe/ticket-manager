import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { planSync, buildEditInstructions, DEFAULT_SYNC_OPTIONS, type ExistingTask } from "../src/domains/projects/index.ts";
import { seed, cleanup, req, userCookie, PROJECT_ID } from "./helpers.ts";

const task = (n: number, extra: Partial<ExistingTask> = {}): ExistingTask => ({
  id: `id${n}`, ticketId: `TM-${n}`, title: `Task ${n}`, description: null, status: "TODO", type: "TASK",
  priority: "MEDIUM", sprintId: "s1", assigneeId: null, labels: [], dueDate: null, position: n, ...extra,
});
const sprints = [{ id: "s1", sprintId: "TM-S1", name: "Sprint 1" }, { id: "s2", sprintId: "TM-S2", name: "Sprint 2" }];
const members = [{ userId: "u1", name: "Ada Lovelace", email: "ada@x.io" }];
const run = (file: unknown, tasks = [task(1), task(2), task(3)], options = DEFAULT_SYNC_OPTIONS) =>
  planSync({ file, tasks, sprints, members, options });

describe("planSync", () => {
  it("only touches fields that are present in the file", () => {
    const p = run({ tasks: [{ ticketId: "TM-1", status: "DONE" }] });
    assert.equal(p.updates.length, 1);
    assert.deepEqual(p.updates[0].changes.map((c) => c.field), ["status"]);
    assert.equal(p.updates[0].patch.title, undefined);
    assert.equal(p.unchanged, 0);
  });

  it("detects status, sprint (by id or name), assignee (by name/email), labels and due date", () => {
    const p = run({ tasks: [{ ticketId: "tm-2", status: "IN_PROGRESS", sprintId: "TM-S2", assignee: "ada@x.io", labels: ["ui", "UI", "api"], dueDate: "2026-12-31" }] });
    const f = p.updates[0].changes.map((c) => c.field).sort();
    assert.deepEqual(f, ["assignee", "dueDate", "labels", "sprint", "status"]);
    assert.deepEqual(p.updates[0].patch.labels, ["ui", "api"]);
    assert.deepEqual(p.updates[0].patch.sprint, { kind: "id", id: "s2" });
    const byName = run({ tasks: [{ ticketId: "TM-3", sprintName: "sprint 2" }] });
    assert.deepEqual(byName.updates[0].patch.sprint, { kind: "id", id: "s2" });
  });

  it("moves to backlog on null, and plans a new sprint for an unknown name", () => {
    const p = run({ tasks: [{ ticketId: "TM-1", sprintId: null, sprintName: null }, { ticketId: "TM-2", sprintName: "Sprint 9" }] });
    assert.deepEqual(p.updates[0].patch.sprint, { kind: "backlog" });
    assert.deepEqual(p.sprintsToCreate, ["Sprint 9"]);
  });

  it("creates tickets without an ID or with an unknown ID, skipping untitled ones", () => {
    const p = run({ tasks: [{ title: "Brand new", status: "TEST" }, { ticketId: "TM-99", title: "Stray" }, { priority: "HIGH" }] });
    assert.equal(p.creates.length, 2);
    assert.equal(p.creates[0].status, "TEST");
    assert.ok(p.warnings.some((w) => w.includes("TM-99")));
    assert.ok(p.warnings.some((w) => w.includes("no title")));
  });

  it("reports tickets missing from the file, and deletes them only when asked", () => {
    const file = { tasks: [{ ticketId: "TM-1" }] };
    const off = run(file);
    assert.deepEqual(off.missing.map((m) => m.ticketId), ["TM-2", "TM-3"]);
    assert.equal(off.deletes.length, 0);
    const on = run(file, undefined, { ...DEFAULT_SYNC_OPTIONS, remove: true });
    assert.equal(on.deletes.length, 2);
  });

  it("respects the option switches", () => {
    const file = { tasks: [{ ticketId: "TM-1", title: "Renamed", status: "DONE" }, { title: "New one" }] };
    const p = run(file, undefined, { create: false, update: true, remove: false, fields: { content: false, status: true, sprint: true, people: true } });
    assert.equal(p.creates.length, 0);
    assert.deepEqual(p.updates[0].changes.map((c) => c.field), ["status"]);
    const none = run(file, undefined, { ...DEFAULT_SYNC_OPTIONS, update: false });
    assert.equal(none.updates.length, 0);
  });

  it("ignores invalid values with a warning and counts identical tickets as unchanged", () => {
    const p = run({ tasks: [{ ticketId: "TM-1", status: "NOPE", dueDate: "2026-02-31", assignee: "Nobody" }, { ticketId: "TM-2", title: "Task 2", status: "TODO" }] });
    assert.equal(p.updates.length, 0);
    assert.equal(p.unchanged, 2);
    assert.equal(p.warnings.length, 3);
  });
});

describe("POST /api/projects/:id/sync", () => {
  let admin = "", member = "";
  before(async () => {
    await seed();
    admin = await userCookie("u_admin");
    member = await userCookie("u_ayse");
    for (const title of ["Alpha", "Beta", "Gamma", "Delta"]) {
      await req(`/api/projects/${PROJECT_ID}/tasks`, { method: "POST", cookie: admin, body: { title } });
    }
  });
  after(async () => { await cleanup(); });

  const exportJson = async () => (await req(`/api/projects/${PROJECT_ID}/export`, { cookie: admin })).json();
  const sync = (body: unknown, cookie = admin) => req(`/api/projects/${PROJECT_ID}/sync`, { method: "POST", cookie, body });

  it("is project-admin only", async () => {
    const data = await exportJson();
    assert.equal((await sync({ data }, member)).status, 403);
  });

  it("an unchanged export is a no-op preview", async () => {
    const data = await exportJson();
    const res = await (await sync({ data })).json();
    assert.equal(res.applied, false);
    assert.equal(res.plan.updateCount, 0);
    assert.equal(res.plan.creates.length, 0);
    assert.equal(res.plan.missingCount, 0);
  });

  it("previews without changing anything, then applies updates, creates and (opt-in) deletes", async () => {
    const data = await exportJson();
    const [first, second, ...rest] = data.tasks;
    const edited = {
      ...data,
      tasks: [
        { ...first, title: first.title + " (edited)", status: "DONE" },
        { ticketId: second.ticketId, priority: "URGENT" },
        { title: "Added by sync", status: "TODO", labels: ["synced"] },
        ...rest.slice(1),
      ],
    };
    const dropped = rest[0];

    const preview = await (await sync({ data: edited, options: { remove: true } })).json();
    assert.equal(preview.applied, false);
    assert.equal(preview.plan.updateCount, 2);
    assert.equal(preview.plan.creates.length, 1);
    assert.equal(preview.plan.deleteCount, 1);
    const unchangedTitle = (await exportJson()).tasks.find((t: any) => t.ticketId === first.ticketId).title;
    assert.equal(unchangedTitle, first.title); // preview wrote nothing

    const done = await (await sync({ data: edited, options: { remove: true }, apply: true })).json();
    assert.deepEqual(done.result, { created: 1, updated: 2, deleted: 1, sprintsCreated: 0 });
    const after = await exportJson();
    const f = after.tasks.find((t: any) => t.ticketId === first.ticketId);
    assert.equal(f.title, first.title + " (edited)");
    assert.equal(f.status, "DONE");
    assert.equal(after.tasks.find((t: any) => t.ticketId === second.ticketId).priority, "URGENT");
    assert.ok(after.tasks.some((t: any) => t.title === "Added by sync" && t.labels.includes("synced")));
    assert.ok(!after.tasks.some((t: any) => t.ticketId === dropped.ticketId));
    assert.ok(f.activity.some((a: any) => a.type === "STATUS_CHANGED" && a.newStatus === "DONE"));
  });

  it("the export carries project-specific editing rules that the sync ignores", async () => {
    const data = await exportJson();
    assert.equal(data.exportVersion, 3);
    const ins = data.instructions;
    assert.ok(ins && Array.isArray(ins.how_to_edit) && Array.isArray(ins.do_not_change));
    assert.deepEqual(ins.allowed_values.status, ["TODO", "IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST", "DONE"]);
    assert.ok(ins.allowed_values.sprints.some((x: any) => x.sprintId === data.sprints[0].sprintId));
    assert.ok(ins.allowed_values.assignee_members.length >= 1);
    const preview = await (await sync({ data })).json();
    assert.equal(preview.plan.updateCount, 0); // rules block does not count as a change
  });

  it("rejects a file without a tasks list", async () => {
    assert.equal((await sync({ data: { project: {} } })).status, 400);
  });
});

describe("buildEditInstructions", () => {
  it("lists the project's real sprints and members and the read-only fields", () => {
    const ins = buildEditInstructions({ prefix: "TM", sprints: [{ sprintId: "TM-S1", name: "Sprint 1" }], members: ["Ada Lovelace"] });
    assert.deepEqual(ins.allowed_values.sprints, [{ sprintId: "TM-S1", name: "Sprint 1" }]);
    assert.deepEqual(ins.allowed_values.assignee_members, ["Ada Lovelace"]);
    assert.ok(ins.do_not_change.some((x) => x.includes("ticketId")));
    assert.ok(ins.you_can_do.delete_a_ticket.includes("explicitly"));
  });
});
