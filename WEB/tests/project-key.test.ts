import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie, PROJECT_ID, PREFIX } from "./helpers.ts";

let superCookie = "";
let memberCookie = "";

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  memberCookie = await userCookie("u_ayse");
});
after(async () => { await cleanup(); });

const create = (name: string, prefix: string) => req("/api/projects", { method: "POST", cookie: superCookie, body: { name, prefix } });
const patch = (id: string, body: unknown, cookie = superCookie) => req(`/api/projects/${id}`, { method: "PATCH", cookie, body });

describe("a project key is unique", () => {
  it("refuses to create a second project with the same key, naming the one that has it", async () => {
    const res = await create("Another", PREFIX);
    assert.equal(res.status, 409);
    const { error } = await res.json();
    assert.match(error, new RegExp(PREFIX));
    assert.match(error, /Test Project/);
  });

  it("treats the key case-insensitively", async () => {
    assert.equal((await create("Another", PREFIX.toLowerCase())).status, 409);
  });

  it("refuses to change a project's key to one another project has", async () => {
    const other = await (await create("Other", "OTH")).json();
    const res = await patch(other.id, { prefix: PREFIX });
    assert.equal(res.status, 409);
    const unchanged = await (await req(`/api/projects/${other.id}`, { cookie: superCookie })).json();
    assert.equal(unchanged.prefix, "OTH");
  });

  it("lets a project keep its own key when it is saved again", async () => {
    assert.equal((await patch(PROJECT_ID, { prefix: PREFIX, name: "Test Project" })).status, 200);
  });

  it("only a project admin may change it", async () => {
    assert.equal((await patch(PROJECT_ID, { prefix: "ZZZ" }, memberCookie)).status, 403);
  });
});

describe("changing a project's key renames its tickets and sprints", () => {
  const tickets = async (id: string) => (await (await req(`/api/projects/${id}/tasks`, { cookie: superCookie })).json()) as Array<{ ticketId: string; title: string }>;
  const sprintCodes = async (id: string) => ((await (await req(`/api/projects/${id}`, { cookie: superCookie })).json()).sprints as Array<{ sprintId: string }>).map((x) => x.sprintId);

  it("renames every ticket id and sprint code, keeps the numbers, and numbers new tickets with the new key", async () => {
    const made = await (await create("Rename me", "OLD")).json();
    for (const title of ["one", "two"]) {
      assert.equal((await req(`/api/projects/${made.id}/tasks`, { method: "POST", cookie: superCookie, body: { title } })).status, 201);
    }
    assert.deepEqual((await tickets(made.id)).map((t) => t.ticketId).sort(), ["OLD-1", "OLD-2"]);
    assert.deepEqual(await sprintCodes(made.id), ["OLD-S1"]);

    assert.equal((await patch(made.id, { prefix: "N" })).status, 400, "a key needs 2-5 letters or digits");
    assert.equal((await patch(made.id, { prefix: "NEW" })).status, 200);

    assert.deepEqual((await tickets(made.id)).map((t) => t.ticketId).sort(), ["NEW-1", "NEW-2"]);
    assert.deepEqual(await sprintCodes(made.id), ["NEW-S1"]);
    const third = await (await req(`/api/projects/${made.id}/tasks`, { method: "POST", cookie: superCookie, body: { title: "three" } })).json();
    assert.equal(third.ticketId, "NEW-3");
  });

  it("does not touch another project's tickets", async () => {
    const before = (await tickets(PROJECT_ID)).map((t) => t.ticketId).sort();
    const made = await (await create("Neighbour", "NBR")).json();
    await patch(made.id, { prefix: "NBX" });
    assert.deepEqual((await tickets(PROJECT_ID)).map((t) => t.ticketId).sort(), before);
  });

  it("a rename that was cut short is finished by saving the same key again", async () => {
    const { getDb } = await import("../src/db/client.ts");
    const { env } = await import("./helpers.ts");
    const { tasks } = await import("../src/db/schema.ts");
    const { eq } = await import("drizzle-orm");
    const made = await (await create("Half", "HLF")).json();
    const t = await (await req(`/api/projects/${made.id}/tasks`, { method: "POST", cookie: superCookie, body: { title: "x" } })).json();
    await getDb(env.DB).update(tasks).set({ ticketId: "OLDX-7" }).where(eq(tasks.id, t.id));
    assert.equal((await patch(made.id, { prefix: "HLF" })).status, 200);
    assert.deepEqual((await tickets(made.id)).map((x) => x.ticketId), ["HLF-7"]);
  });
});
