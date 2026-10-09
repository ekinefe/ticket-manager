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

describe("github commit graph", () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];

  before(async () => {
    const { generateKeyPairSync } = await import("node:crypto");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    env.GITHUB_APP_ID = "123";
    env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const commit = (sha: string, parents: string[], msg: string, day: number) => ({
      sha, parents: parents.map((p) => ({ sha: p })), html_url: `https://github.com/me/app/commit/${sha}`,
      commit: { message: msg, author: { name: "Dev", email: "dev@x.io", date: new Date(Date.UTC(2026, 9, day)).toISOString() } },
    });
    globalThis.fetch = (async (input: any) => {
      const url = String(input?.url ?? input);
      if (!url.startsWith("https://api.github.com")) return realFetch(input);
      calls.push(url);
      if (url.endsWith("/repos/me/app/installation")) return json({ id: 9 });
      if (url.endsWith("/app/installations/9/access_tokens")) return json({ token: "t" }, 201);
      if (url.endsWith("/repos/me/app")) return json({ default_branch: "main" });
      if (url.includes("/branches")) return json([{ name: "main", commit: { sha: "m2" } }, { name: "feature/TST-980", commit: { sha: "f1" } }]);
      if (url.includes("/pulls?")) return json([
        { number: 7, title: "TST-980 login", html_url: "https://github.com/me/app/pull/7", state: "closed", draft: false, user: { login: "dev" }, head: { ref: "feature/TST-980" }, created_at: new Date(Date.UTC(2026, 9, 2)).toISOString(), merged_at: new Date(Date.UTC(2026, 9, 5)).toISOString(), closed_at: new Date(Date.UTC(2026, 9, 5)).toISOString() },
        { number: 8, title: "WIP", html_url: "https://github.com/me/app/pull/8", state: "open", draft: true, user: { login: "dev" }, head: { ref: "x" }, created_at: new Date(Date.UTC(2026, 9, 6)).toISOString(), merged_at: null, closed_at: null },
      ]);
      if (url.includes("sha=main")) return json([commit("m2", ["m1"], "Merge TST-980", 5), commit("m1", [], "init", 1)]);
      if (url.includes("sha=feature")) return json([commit("f1", ["m1"], "work on TST-980", 3)]);
      return json({}, 404);
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
    delete env.GITHUB_APP_ID;
    delete env.GITHUB_APP_PRIVATE_KEY;
  });

  it("returns commits with parents, branch tips and ticket ids — no e-mails", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/github/graph`, { cookie: ayse });
    assert.equal(res.status, 200);
    const text = await res.text();
    const g = JSON.parse(text);
    assert.deepEqual(g.commits.map((c: any) => c.sha), ["m2", "f1", "m1"], "newest first");
    assert.deepEqual(g.commits[0].parents, ["m1"]);
    assert.deepEqual(g.commits[1].tickets, ["TST-980"]);
    assert.equal(g.branches[0].name, "main");
    assert.ok(!text.includes("dev@x.io"));
    assert.deepEqual(g.pulls.map((p: any) => [p.number, p.state]), [[7, "merged"], [8, "draft"]]);
    assert.ok(g.pulls[0].endedAt > g.pulls[0].createdAt);
    assert.deepEqual(g.pulls[0].tickets, ["TST-980"]);
  });

  it("is cached briefly and denied to non-members", async () => {
    const before = calls.length;
    await req(`/api/projects/${PROJECT_ID}/github/graph`, { cookie: ayse });
    assert.equal(calls.length, before, "second call served from cache");
    assert.equal((await req(`/api/projects/${PROJECT_ID}/github/graph`, { cookie: zeynep })).status, 403);
  });
});

describe("github settings from the database", () => {
  it("applies DB-stored credentials to GitHub routes even when env has none (Workers case)", async () => {
    const { appSettings } = await import("../src/db/schema.ts");
    await getDb(env.DB).insert(appSettings).values({ key: "github_webhook_secret", value: "db_secret", updatedAt: Date.now() });
    const saved = env.GITHUB_WEBHOOK_SECRET;
    delete env.GITHUB_WEBHOOK_SECRET;
    try {
      const res = await hook("ping", { zen: "x" }, "db_secret");
      assert.equal(res.status, 200);
    } finally {
      env.GITHUB_WEBHOOK_SECRET = saved;
    }
  });
});
