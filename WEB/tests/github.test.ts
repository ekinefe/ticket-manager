import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { seed, cleanup, req, userCookie, env, app, PROJECT_ID, PREFIX } from "./helpers.ts";
import { extractTicketIds } from "../src/lib/github.ts";
const { getDb } = await import("../src/db/client.ts");
const { tasks } = await import("../src/db/schema.ts");

const SECRET = "whsec_test";
let superCookie = "";
let ayse = "";
let zeynep = "";

async function hook(event: string, payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return app.request("/api/github/webhook", {
    method: "POST",
    headers: { "x-github-event": event, "x-hub-signature-256": sig, "content-type": "application/json" },
    body: raw,
  });
}

const statusOf = async (id: string) => {
  const list = await (await req(`/api/projects/${PROJECT_ID}/tasks`, { cookie: superCookie })).json();
  return list.find((t: any) => t.id === id).status;
};

before(async () => {
  await seed();
  env.GITHUB_WEBHOOK_SECRET = SECRET;
  superCookie = await userCookie("u_super");
  ayse = await userCookie("u_ayse");
  zeynep = await userCookie("u_zeynep");
  const db = getDb(env.DB);
  const at = Date.now();
  for (const [i, status] of ["TODO", "IN_PROGRESS", "DEPLOYED"].entries()) {
    await db.insert(tasks).values({
      id: `t_gh_${i}`, projectId: PROJECT_ID, ticketId: `${PREFIX}-98${i}`, title: `GH ${i}`,
      status, position: i, createdAt: at, updatedAt: at,
    });
  }
});

after(async () => {
  await cleanup();
});

describe("github helpers", () => {
  it("extracts only ticket ids of the given prefix", () => {
    assert.deepEqual(extractTicketIds("TST", "fix TST-12 and tst-7, not XTST-3 or OTHER-9, TST-123"), ["TST-12", "TST-7", "TST-123"]);
    assert.deepEqual(extractTicketIds("TST", null, "feature/TST-5-login"), ["TST-5"]);
  });
});

describe("github integration", () => {
  it("links a repo: project admins only, validated and unique", async () => {
    const url = `/api/projects/${PROJECT_ID}/github`;
    assert.equal((await req(url, { method: "PATCH", cookie: ayse, body: { repo: "me/app" } })).status, 403);
    assert.equal((await req(url, { method: "PATCH", cookie: superCookie, body: { repo: "not a repo" } })).status, 400);
    const ok = await (await req(url, { method: "PATCH", cookie: superCookie, body: { repo: "https://github.com/Me/App.git" } })).json();
    assert.equal(ok.repo, "me/app");
  });

  it("rejects webhooks with a missing or wrong signature", async () => {
    assert.equal((await hook("push", {}, "wrong")).status, 401);
    const res = await app.request("/api/github/webhook", { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
  });

  it("ignores events from unlinked repositories", async () => {
    const res = await hook("push", { repository: { full_name: "other/repo" }, commits: [] });
    assert.equal((await res.json()).handled, false);
  });

  it("records commits and links them to tickets by message and branch", async () => {
    const res = await hook("push", {
      ref: "refs/heads/feature/TST-981",
      repository: { full_name: "Me/App" },
      commits: [
        { id: "abc123", message: "Fix login TST-980\n\nbody", url: "https://github.com/me/app/commit/abc123", author: { name: "Dev", email: "dev@x.io" }, timestamp: new Date().toISOString() },
      ],
    });
    assert.equal(res.status, 200);
    const t0 = await (await req(`/api/projects/${PROJECT_ID}/tasks/t_gh_0/github`, { cookie: ayse })).json();
    assert.equal(t0.events[0].ref, "abc123");
    assert.equal(t0.events[0].title, "Fix login TST-980");
    const t1 = await (await req(`/api/projects/${PROJECT_ID}/tasks/t_gh_1/github`, { cookie: ayse })).json();
    assert.equal(t1.events.length, 1, "branch name links the commit to TST-981 too");
    assert.ok(!JSON.stringify(t0).includes("dev@x.io"), "commit e-mail is never stored");
  });

  it("moves tickets: PR opened → Under Review, merged → Done; never backwards", async () => {
    const pr = (action: string, extra: object = {}) => ({
      action, repository: { full_name: "me/app" },
      pull_request: { number: 7, title: "Work on TST-980 and TST-982", body: "", state: "open", draft: false, merged: false,
        html_url: "https://github.com/me/app/pull/7", user: { login: "dev" }, head: { ref: "feature/x" }, created_at: new Date().toISOString(), ...extra },
    });
    await hook("pull_request", pr("opened"));
    assert.equal(await statusOf("t_gh_0"), "UNDER_REVIEW");
    assert.equal(await statusOf("t_gh_2"), "DEPLOYED", "a later status is not pulled back to Under Review");

    await hook("pull_request", pr("closed", { state: "closed", merged: true }));
    assert.equal(await statusOf("t_gh_0"), "DONE");
    assert.equal(await statusOf("t_gh_2"), "DONE");

    const t0 = await (await req(`/api/projects/${PROJECT_ID}/tasks/t_gh_0/github`, { cookie: ayse })).json();
    const prRow = t0.events.find((e: any) => e.kind === "PR");
    assert.equal(prRow.state, "merged");
    assert.equal(t0.events.filter((e: any) => e.kind === "PR").length, 1, "PR upserted, not duplicated");
  });

  it("does not move tickets for draft PRs", async () => {
    await hook("pull_request", {
      action: "opened", repository: { full_name: "me/app" },
      pull_request: { number: 8, title: "WIP TST-981", state: "open", draft: true, merged: false, user: { login: "dev" }, head: { ref: "x" }, created_at: new Date().toISOString() },
    });
    assert.equal(await statusOf("t_gh_1"), "IN_PROGRESS");
  });

  it("shows dashboard activity to members only; branch creation is off by default", async () => {
    const mine = await (await req("/api/github/activity", { cookie: ayse })).json();
    assert.ok(mine.length >= 2);
    assert.deepEqual(await (await req("/api/github/activity", { cookie: zeynep })).json(), []);
    const t = await (await req(`/api/projects/${PROJECT_ID}/tasks/t_gh_0/github`, { cookie: superCookie })).json();
    assert.equal(t.branchEnabled, false);
    assert.equal(t.branchName, "feature/TST-980");
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/t_gh_0/github/branch`, { method: "POST", cookie: superCookie });
    assert.equal(res.status, 403);
  });
});
