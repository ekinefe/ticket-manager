import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { seed, cleanup, req, userCookie, env, PROJECT_ID } from "./helpers.ts";
const { getDb } = await import("../src/db/client.ts");
const { tasks, taskComments } = await import("../src/db/schema.ts");

let superCookie = "";
let ayse = "";
let zeynep = "";
const share = `/api/projects/${PROJECT_ID}/tasks/t_share/share`;

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  ayse = await userCookie("u_ayse");
  zeynep = await userCookie("u_zeynep");
  const db = getDb(env.DB);
  const at = Date.now();
  await db.insert(tasks).values({
    id: "t_share", projectId: PROJECT_ID, ticketId: "TST-970", title: "Shared one",
    description: "<p>hello</p>", status: "TODO", assigneeId: "u_ayse", createdBy: "u_super",
    position: 1, createdAt: at, updatedAt: at,
  });
  await db.insert(taskComments).values({ id: "c_share", taskId: "t_share", authorId: "u_ayse", body: "a comment", createdAt: at });
});

after(async () => {
  await cleanup();
});

describe("ticket sharing", () => {
  it("is off by default and the link does not resolve", async () => {
    assert.equal((await req("/api/share/whatever")).status, 404);
  });

  it("only project admins / super admin can change sharing", async () => {
    assert.equal((await req(share, { method: "PUT", cookie: ayse, body: { mode: "LINK" } })).status, 403);
    assert.equal((await req(share, { method: "PUT", cookie: zeynep, body: { mode: "LINK" } })).status, 403);
    assert.equal((await req(share, { method: "PUT", cookie: superCookie, body: { mode: "BOGUS" } })).status, 400);
  });

  it("LINK mode: anonymous read-only view without emails", async () => {
    const put = await (await req(share, { method: "PUT", cookie: superCookie, body: { mode: "LINK" } })).json();
    assert.ok(put.token.length >= 30);
    const res = await req(`/api/share/${put.token}`);
    assert.equal(res.status, 200);
    const text = await res.text();
    const data = JSON.parse(text);
    assert.equal(data.ticket.title, "Shared one");
    assert.equal(data.ticket.assigneeName, "ayse");
    assert.equal(data.comments[0].body, "a comment");
    assert.equal(data.viewer.signedIn, false);
    assert.equal(data.projectId, undefined);
    assert.ok(!text.includes("@test.local"), "no e-mail addresses in the public payload");
  });

  it("never leaks the token through the member ticket list", async () => {
    const list = await (await req(`/api/projects/${PROJECT_ID}/tasks`, { cookie: ayse })).json();
    const t = list.find((x: any) => x.id === "t_share");
    assert.equal(t.shareMode, "LINK");
    assert.equal("shareToken" in t, false);
  });

  it("ACCOUNT mode needs a session; non-members get a view-only page", async () => {
    const put = await (await req(share, { method: "PUT", cookie: superCookie, body: { mode: "ACCOUNT" } })).json();
    assert.equal((await req(`/api/share/${put.token}`)).status, 401);
    const asOutsider = await (await req(`/api/share/${put.token}`, { cookie: zeynep })).json();
    assert.equal(asOutsider.viewer.isMember, false);
    assert.equal(asOutsider.projectId, undefined);
    const asMember = await (await req(`/api/share/${put.token}`, { cookie: ayse })).json();
    assert.equal(asMember.viewer.isMember, true);
  });

  it("turning it off revokes the old link; regenerate rotates it", async () => {
    const on = await (await req(share, { method: "PUT", cookie: superCookie, body: { mode: "LINK" } })).json();
    const rotated = await (await req(share, { method: "PUT", cookie: superCookie, body: { mode: "LINK", regenerate: true } })).json();
    assert.notEqual(on.token, rotated.token);
    assert.equal((await req(`/api/share/${on.token}`)).status, 404);
    assert.equal((await req(`/api/share/${rotated.token}`)).status, 200);
    const off = await (await req(share, { method: "PUT", cookie: superCookie, body: { mode: "OFF" } })).json();
    assert.equal(off.token, null);
    assert.equal((await req(`/api/share/${rotated.token}`)).status, 404);
  });
});
