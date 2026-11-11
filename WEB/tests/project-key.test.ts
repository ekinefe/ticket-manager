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
