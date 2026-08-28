import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  app, env, seed, cleanup, req, userCookie, signIn, USERS, PROJECT_ID, PREFIX,
} from "./helpers.ts";

const MAIL_OUT = join(process.cwd(), ".mail-out");

function newestMail(): string {
  const files = readdirSync(MAIL_OUT).filter((f) => f.endsWith(".html"));
  const sorted = files.sort((a, b) => (a < b ? 1 : -1));
  return readFileSync(join(MAIL_OUT, sorted[0]), "utf8");
}

let superCookie = "";
let adminCookie = "";
let member1 = "";
let member2 = "";
let outsider = "";

before(async () => {
  await seed();
  superCookie = await userCookie("u_super");
  adminCookie = await userCookie("u_admin");
  member1 = await userCookie("u_ayse");
  member2 = await userCookie("u_mehmet");
  outsider = await userCookie("u_zeynep");
});

after(async () => {
  await cleanup();
});

describe("authentication", () => {
  it("exposes an unauthenticated health probe", async () => {
    const res = await req("/api/health");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Number(data.time) > 0);
  });

  it("rejects anonymous API access with 401", async () => {
    const res = await req("/api/projects");
    assert.equal(res.status, 401);
  });

  it("blocks public sign-up with 403", async () => {
    const res = await req("/api/auth/sign-up/email", {
      method: "POST",
      body: { email: "x@y.z", password: "12345678" },
    });
    assert.equal(res.status, 403);
  });

  it("signs in seeded users", async () => {
    const res = await req("/api/auth/get-session", { cookie: member1 });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.role, "USER");
  });
});

describe("rbac", () => {
  it("forbids USER role from the admin user list", async () => {
    const res = await req("/api/admin/users", { cookie: member1 });
    assert.equal(res.status, 403);
  });

  it("allows ADMIN role to read the user list", async () => {
    const res = await req("/api/admin/users", { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
  });

  it("forbids non-members from reading project tasks", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/tasks`, { cookie: outsider });
    assert.equal(res.status, 403);
  });

  it("forbids USER role from creating projects", async () => {
    const res = await req("/api/projects", {
      method: "POST", cookie: member1,
      body: { name: "Nope", prefix: "NOP" },
    });
    assert.equal(res.status, 403);
  });

  it("allows ADMIN role to create projects", async () => {
    const res = await req("/api/projects", {
      method: "POST", cookie: adminCookie,
      body: { name: "CI Project", prefix: "CIP" },
    });
    assert.equal(res.status, 201);
    const project = await res.json();
    assert.equal(project.prefix, "CIP");
  });

  it("forbids super admin self-role change and self-delete", async () => {
    const patch = await req("/api/admin/users/u_super", {
      method: "PATCH", cookie: superCookie, body: { role: "USER" },
    });
    assert.equal(patch.status, 400);
    const del = await req("/api/admin/users/u_super", { method: "DELETE", cookie: superCookie });
    assert.equal(del.status, 400);
  });

  it("strict model: global ADMIN has no implicit project access", async () => {
    // Super creates a project; only the creator (super) is a member.
    const create = await req("/api/projects", {
      method: "POST", cookie: superCookie,
      body: { name: "Strict Model", prefix: "STM" },
    });
    assert.equal(create.status, 201);
    const project = await create.json();

    // Global ADMIN without membership: no access (was implicit before v1.5).
    const denied = await req(`/api/projects/${project.id}/tasks`, { cookie: adminCookie });
    assert.equal(denied.status, 403);
    const list = await req("/api/projects", { cookie: adminCookie });
    const projects = await list.json();
    assert.ok(!projects.some((p: { id: string }) => p.id === project.id));

    // Granting membership unlocks access.
    const grant = await req(`/api/admin/projects/${project.id}/members`, {
      method: "POST", cookie: superCookie, body: { userId: "u_admin", role: "ADMIN" },
    });
    assert.equal(grant.status, 200);
    const allowed = await req(`/api/projects/${project.id}/tasks`, { cookie: adminCookie });
    assert.equal(allowed.status, 200);
  });
});

describe("tickets", () => {
  it("allocates unique sequential ticket IDs", async () => {
    const r1 = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "First", assigneeId: "u_ayse" },
    });
    const r2 = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "Second", assigneeId: "u_ayse" },
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    const t1 = await r1.json();
    const t2 = await r2.json();
    assert.equal(t1.ticketId, `${PREFIX}-1`);
    assert.equal(t2.ticketId, `${PREFIX}-2`);
    assert.notEqual(t1.id, t2.id);
  });

  it("forbids members from editing tickets they did not create and are not assigned", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "Ayse only" },
    });
    const task = await create.json();
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "PATCH", cookie: member2, body: { title: "hijacked" },
    });
    assert.equal(res.status, 403);
  });

  it("forbids members from changing priority (admin-only field)", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "Prio test", assigneeId: "u_ayse" },
    });
    const task = await create.json();
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "PATCH", cookie: member1, body: { priority: "URGENT" },
    });
    assert.equal(res.status, 403);
  });

  it("allows project admins to change priority", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "Prio admin", assigneeId: "u_ayse" },
    });
    const task = await create.json();
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "PATCH", cookie: adminCookie, body: { priority: "HIGH" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).priority, "HIGH");
  });

  it("forbids members from deleting tickets, allows admins", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member1, body: { title: "Delete me" },
    });
    const task = await create.json();
    const asMember = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "DELETE", cookie: member1,
    });
    assert.equal(asMember.status, 403);
    const asAdmin = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "DELETE", cookie: adminCookie,
    });
    assert.equal(asAdmin.status, 200);
  });

  it("supports pagination parameters", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/tasks?page=1&perPage=2`, { cookie: member1 });
    assert.equal(res.status, 200);
    const rows = await res.json();
    assert.ok(rows.length <= 2);
  });

  it("sanitizes unsafe description HTML on the server", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: adminCookie,
      body: {
        title: "Sanitize check",
        description: '<p onclick="x">ok</p><script>alert(1)</script><img src="https://evil.com/x.png">',
      },
    });
    assert.equal(create.status, 201);
    const task = await create.json();
    assert.equal(task.description, "<p>ok</p>alert(1)");
  });
});

describe("invitations", () => {
  it("creates, accepts, and single-uses a project invitation", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/invitations`, {
      method: "POST", cookie: adminCookie,
      body: { email: "newbie@test.local", role: "MEMBER" },
    });
    assert.equal(create.status, 201);
    const { devInviteUrl } = await create.json();
    const token = new URL(devInviteUrl).searchParams.get("token")!;

    const accept = await req("/api/invitations/accept", {
      method: "POST",
      body: { token, name: "Newbie", password: "newbie123!" },
    });
    assert.equal(accept.status, 200);

    // Token is single-use.
    const reuse = await req("/api/invitations/accept", {
      method: "POST",
      body: { token, name: "Newbie", password: "newbie123!" },
    });
    assert.equal(reuse.status, 410);

    // New account can sign in and has USER role.
    const cookie = await signIn("newbie@test.local", "newbie123!");
    const session = await req("/api/auth/get-session", { cookie });
    assert.equal((await session.json()).user.role, "USER");
  });

  it("rejects duplicate pending invitations with 409", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/invitations`, {
      method: "POST", cookie: adminCookie,
      body: { email: "newbie@test.local", role: "MEMBER" },
    });
    assert.equal(res.status, 409);
  });

  it("creates standalone account invites (super admin only)", async () => {
    const asAdmin = await req("/api/admin/invites", {
      method: "POST", cookie: adminCookie, body: { email: "acct@test.local" },
    });
    assert.equal(asAdmin.status, 403);

    const asSuper = await req("/api/admin/invites", {
      method: "POST", cookie: superCookie, body: { email: "acct@test.local" },
    });
    assert.equal(asSuper.status, 201);
    const { devInviteUrl } = await asSuper.json();
    const token = new URL(devInviteUrl).searchParams.get("token")!;
    const accept = await req("/api/invitations/accept", {
      method: "POST", body: { token, password: "acct1234!" },
    });
    assert.equal(accept.status, 200);
    const cookie = await signIn("acct@test.local", "acct1234!");
    const list = await req("/api/admin/users", { cookie: superCookie });
    const users = await list.json();
    const acct = users.find((u: { email: string }) => u.email === "acct@test.local");
    assert.equal(acct.role, "USER");
    void cookie;
  });
});

describe("password reset", () => {
  it("requests, confirms, revokes sessions, and never enumerates accounts", async () => {
    const unknown = await req("/api/auth/request-password-reset", {
      method: "POST", body: { email: "ghost@test.local" },
    });
    assert.equal(unknown.status, 200); // no enumeration

    const request = await req("/api/auth/request-password-reset", {
      method: "POST", body: { email: "ayse@test.local" },
    });
    assert.equal(request.status, 200);

    // The dev file transport wrote the mail; extract the token from it.
    const html = newestMail();
    const match = html.match(/token=([A-Za-z0-9_-]+)/);
    assert.ok(match, "reset link found in outbox");
    const token = match[1];

    const confirm = await req("/api/auth/reset-password", {
      method: "POST", body: { token, password: "brandnew123!" },
    });
    assert.equal(confirm.status, 200);

    // Old password no longer works, new one does.
    await assert.rejects(() => signIn("ayse@test.local", "member123!"));
    const newCookie = await signIn("ayse@test.local", "brandnew123!");
    assert.ok(newCookie.includes("better-auth") || newCookie.length > 0);

    // Token is single-use.
    const reuse = await req("/api/auth/reset-password", {
      method: "POST", body: { token, password: "another123!" },
    });
    assert.equal(reuse.status, 410);
  });
});

describe("search", () => {
  // Uses member2: the password-reset test above revokes member1's session.
  it("finds tickets by glued normalized ID (pln-style)", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member2, body: { title: "Searchable one" },
    });
    const task = await create.json(); // TST-n
    const n = task.ticketId.split("-")[1];
    const res = await req(`/api/search?q=${PREFIX.toLowerCase()}${n}`, { cookie: member2 });
    const data = await res.json();
    assert.ok(data.tickets.some((t: { ticketId: string }) => t.ticketId === task.ticketId));
  });

  it("never leaks users to USER-role searchers", async () => {
    const res = await req("/api/search?q=super", { cookie: member2 });
    const data = await res.json();
    assert.deepEqual(data.users, []);
  });

  it("never leaks inaccessible projects", async () => {
    const res = await req("/api/search?q=cip", { cookie: outsider });
    const data = await res.json();
    assert.equal(data.projects.length, 0);
    assert.equal(data.tickets.length, 0);
  });
});

describe("realtime (SSE)", () => {
  // Uses member2: the password-reset test above revokes member1's session.
  it("pushes a ticket-changed event when a ticket is created", async () => {
    const stream = await req(`/api/projects/${PROJECT_ID}/stream`, { cookie: member2 });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("content-type"), "text/event-stream");

    const reader = stream.body.getReader();
    // Connection banner arrives first.
    await reader.read();

    const create = req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: adminCookie, body: { title: "SSE probe" },
    });
    const read = reader.read();
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 3000));
    const result = await Promise.race([read.then((r) => new TextDecoder().decode(r.value)), timeout]);
    await create;
    reader.cancel().catch(() => {});

    assert.notEqual(result, "timeout", "SSE event should arrive promptly");
    assert.ok(result.includes("event: ticket-changed"));
    assert.ok(result.includes('"type":"created"'));
  });

  it("forbids non-members from subscribing", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/stream`, { cookie: outsider });
    assert.equal(res.status, 403);
  });
});

describe("email jobs", () => {
  const DAY = "2030-01-01"; // synthetic window, unique per fresh test DB

  function mailFiles(): Set<string> {
    return new Set(readdirSync(MAIL_OUT));
  }

  function readNewMails(before: Set<string>): string[] {
    return [...mailFiles()]
      .filter((f) => !before.has(f) && f.endsWith(".html"))
      .map((f) => readFileSync(join(MAIL_OUT, f), "utf8"));
  }

  it("daily digest lists closed and in-progress tickets for members", async () => {
    const db = (await import("./helpers.ts")).env.DB;
    const { getDb } = await import("../src/db/client.ts");
    const { activityLog } = await import("../src/db/schema.ts");
    const db2 = getDb(db);

    // A ticket closed inside the synthetic window.
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: adminCookie, body: { title: "Digest probe" },
    });
    const task = await create.json();
    const windowStart = Date.parse(`${DAY}T00:00:00Z`);
    await db2.insert(activityLog).values({
      id: crypto.randomUUID(),
      taskId: task.id,
      actorId: "u_admin",
      eventType: "STATUS_CHANGED",
      newStatus: "DONE",
      createdAt: windowStart + 3_600_000,
    });

    const before = mailFiles();
    const { runDailyDigest } = await import("../src/cron/jobs/daily-digest.ts");
    await runDailyDigest(env, DAY);
    const mails = readNewMails(before);

    const digest = mails.find((m) => m.includes("Daily digest") && m.includes("Test Project"));
    assert.ok(digest, "digest mail for Test Project written");
    assert.ok(digest.includes(task.ticketId), "closed ticket listed");
    assert.ok(mailFiles().has([...mailFiles()].find((f) => f.includes("ayse-test-local") && f.includes("daily-digest")) ?? ""), "member ayse is a recipient");
    void db2; void db;

    // Idempotent per period: a second run sends nothing.
    const snapshot = mailFiles();
    await runDailyDigest(env, DAY);
    assert.deepEqual(mailFiles(), snapshot);
  });

  it("weekly report goes to project admins and super admins", async () => {
    const before = mailFiles();
    const { runWeeklyReport } = await import("../src/cron/jobs/weekly-report.ts");
    await runWeeklyReport(env, "2030-01-05"); // week containing DAY
    const mails = readNewMails(before);

    const report = mails.find((m) => m.includes("Weekly report") && m.includes("Test Project"));
    assert.ok(report, "weekly report for Test Project written");
    assert.ok(
      [...mailFiles()].some((f) => f.includes("super-test-local") && f.includes("weekly-report")),
      "super admin is a recipient"
    );
  });

  it("security scan reports HIGH findings once, then de-duplicates", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("querybatch")) {
        return new Response(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-TEST-0001" }] }] }), { status: 200 });
      }
      if (url.includes("vulns/GHSA-TEST-0001")) {
        return new Response(JSON.stringify({
          id: "GHSA-TEST-0001",
          aliases: ["CVE-2099-0001"],
          database_specific: { severity: "HIGH" },
          affected: [{
            package: { name: "drizzle-orm" },
            ranges: [{ type: "SEMVER", events: [{ fixed: "9.9.9" }] }],
          }],
        }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    try {
      const { runSecurityScan } = await import("../src/cron/jobs/security-scan.ts");
      const before = mailFiles();
      await runSecurityScan(env, "2030-02-01");
      let mails = readNewMails(before);
      const report = mails.find((m) => m.includes("CVE-2099-0001"));
      assert.ok(report, "security report contains the CVE");
      assert.ok(report.includes("drizzle-orm"), "affected package named");

      // Same open finding is not re-reported on the next scan.
      const snapshot = mailFiles();
      await runSecurityScan(env, "2030-02-08");
      mails = readNewMails(snapshot);
      assert.ok(!mails.some((m) => m.includes("CVE-2099-0001")), "open finding de-duplicated");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("cron idempotency", () => {
  it("runs a job once per period key", async () => {
    const { runOnce } = await import("../src/cron/guard.ts");
    const first = await runOnce(env, "test_job", "period-1");
    const second = await runOnce(env, "test_job", "period-1");
    assert.equal(first, true);
    assert.equal(second, false);
  });
});

describe("comments", () => {
  it("members can post and read comments; empty/oversized rejected", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member2, body: { title: "Comment target" },
    });
    const task = await create.json();

    const empty = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/comments`, {
      method: "POST", cookie: member2, body: { body: "   " },
    });
    assert.equal(empty.status, 400);

    const oversized = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/comments`, {
      method: "POST", cookie: member2, body: { body: "x".repeat(4001) },
    });
    assert.equal(oversized.status, 400);

    const post = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/comments`, {
      method: "POST", cookie: member2, body: { body: "first!" },
    });
    assert.equal(post.status, 201);
    assert.equal((await post.json()).authorName, "mehmet");

    const list = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/comments`, { cookie: member2 });
    const rows = await list.json();
    assert.ok(rows.some((c: { body: string }) => c.body === "first!"));
  });

  it("forbids non-members from commenting", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member2, body: { title: "No comment" },
    });
    const task = await create.json();
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/comments`, {
      method: "POST", cookie: outsider, body: { body: "sneak" },
    });
    assert.equal(res.status, 403);
  });
});

describe("media upload", () => {
  it("stores whitelisted image uploads under /media/uploads/", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append("file", new File([png], "probe.png", { type: "image/png" }));
    const res = await req(`/api/projects/${PROJECT_ID}/media`, { method: "POST", cookie: member2, form });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.ok(data.url.startsWith("/media/uploads/"));
    assert.ok(data.url.endsWith(".png"));
  });

  it("rejects non-whitelisted MIME types with 415", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "a.txt", { type: "text/plain" }));
    const res = await req(`/api/projects/${PROJECT_ID}/media`, { method: "POST", cookie: member2, form });
    assert.equal(res.status, 415);
  });
});

describe("activity feed", () => {
  it("records CREATED and STATUS_CHANGED with actor names", async () => {
    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: member2, body: { title: "History probe" },
    });
    const task = await create.json();
    await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "PATCH", cookie: adminCookie, body: { status: "IN_PROGRESS" },
    });
    const res = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}/events`, { cookie: member2 });
    const events = await res.json();
    const types = events.map((e: { type: string }) => e.type);
    assert.ok(types.includes("CREATED"));
    assert.ok(types.includes("STATUS_CHANGED"));
    const statusEvent = events.find((e: { type: string }) => e.type === "STATUS_CHANGED");
    assert.equal(statusEvent.actorName, "admin");
    assert.equal(statusEvent.newStatus, "IN_PROGRESS");
  });
});

describe("admin membership endpoints (both directions)", () => {
  it("project side: lists members with global role, upserts and removes", async () => {
    const list = await req(`/api/admin/projects/${PROJECT_ID}/members`, { cookie: superCookie });
    const { members } = await list.json();
    assert.ok(members.some((m: { userId: string; globalRole: string }) => m.userId === "u_ayse" && m.globalRole === "USER"));

    // Promote mehmet to project ADMIN, verify effect, then remove.
    const upsert = await req(`/api/admin/projects/${PROJECT_ID}/members`, {
      method: "POST", cookie: superCookie, body: { userId: "u_mehmet", role: "ADMIN" },
    });
    assert.equal(upsert.status, 200);

    const create = await req(`/api/projects/${PROJECT_ID}/tasks`, {
      method: "POST", cookie: adminCookie, body: { title: "Mehmet can delete this" },
    });
    const task = await create.json();
    const del = await req(`/api/projects/${PROJECT_ID}/tasks/${task.id}`, {
      method: "DELETE", cookie: member2, // mehmet, now project ADMIN
    });
    assert.equal(del.status, 200);

    const remove = await req(`/api/admin/projects/${PROJECT_ID}/members/u_mehmet`, {
      method: "DELETE", cookie: superCookie,
    });
    assert.equal(remove.status, 200);
    const denied = await req(`/api/projects/${PROJECT_ID}/tasks`, { cookie: member2 });
    assert.equal(denied.status, 403);
  });

  it("user side: grant and revoke access to a project", async () => {
    // CIP was created by the global admin earlier; mehmet is not a member.
    const projects = await (await req("/api/projects", { cookie: adminCookie })).json();
    const cip = projects.find((p: { prefix: string }) => p.prefix === "CIP");
    assert.ok(cip, "CIP project exists from earlier test");

    const denied = await req(`/api/projects/${cip.id}/tasks`, { cookie: member2 });
    assert.equal(denied.status, 403);

    const grant = await req(`/api/admin/users/u_mehmet/projects`, {
      method: "POST", cookie: superCookie, body: { projectId: cip.id, role: "MEMBER" },
    });
    assert.equal(grant.status, 200);
    const allowed = await req(`/api/projects/${cip.id}/tasks`, { cookie: member2 });
    assert.equal(allowed.status, 200);

    const revoke = await req(`/api/admin/users/u_mehmet/projects/${cip.id}`, {
      method: "DELETE", cookie: superCookie,
    });
    assert.equal(revoke.status, 200);
    const deniedAgain = await req(`/api/projects/${cip.id}/tasks`, { cookie: member2 });
    assert.equal(deniedAgain.status, 403);
  });
});

describe("invitation expiry", () => {
  it("rejects expired invitation tokens with 410", async () => {
    const { hashInviteToken } = await import("../src/lib/invite.ts");
    const { getDb } = await import("../src/db/client.ts");
    const { invitations } = await import("../src/db/schema.ts");
    const token = "expired-token-" + crypto.randomUUID();
    const { tokenHash } = await hashInviteToken(token);
    await getDb(env.DB).insert(invitations).values({
      id: crypto.randomUUID(),
      projectId: PROJECT_ID,
      email: "expired@test.local",
      tokenHash,
      invitedRole: "MEMBER",
      expiresAt: Date.now() - 1000,
      createdBy: "u_admin",
      createdAt: Date.now() - 2000,
    });
    const res = await req("/api/invitations/accept", {
      method: "POST", body: { token, name: "Late", password: "latelate1" },
    });
    assert.equal(res.status, 410);
  });
});

describe("export / import", () => {
  it("exports a project as JSON", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/export`, { cookie: superCookie });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.project.name, "Test Project");
    assert.equal(data.project.prefix, PREFIX);
    assert.ok(Array.isArray(data.sprints));
    assert.ok(data.sprints.length >= 1);
    assert.ok(Array.isArray(data.tasks));
  });

  it("rejects export from non-member", async () => {
    const res = await req(`/api/projects/${PROJECT_ID}/export`, { cookie: outsider });
    assert.equal(res.status, 403);
  });

  it("imports a new project from JSON", async () => {
    const payload = {
      project: { name: "Imported Project", prefix: "IMP" },
      sprints: [
        { name: "Phase 1" },
        { name: "Phase 2" },
      ],
      tasks: [
        { title: "Task one", status: "TODO", priority: "HIGH", sprint: 0 },
        { title: "Task two", status: "IN_PROGRESS", type: "BUG", sprint: 0 },
        { title: "Task three", status: "DONE", sprint: 1, assigneeId: "u_ayse" },
        { title: "No sprint task", status: "TODO" },
      ],
    };
    const res = await req("/api/projects/import", { method: "POST", cookie: superCookie, body: payload });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.projectId);
    assert.equal(data.sprintsCreated, 2);
    assert.equal(data.tasksCreated, 4);

    // Verify project exists
    const projRes = await req(`/api/projects/${data.projectId}`, { cookie: superCookie });
    assert.equal(projRes.status, 200);
    const proj = await projRes.json();
    assert.equal(proj.name, "Imported Project");
    assert.equal(proj.sprints.length, 2);
    assert.equal(proj.sprints[0].name, "Phase 1");
    assert.equal(proj.sprints[1].name, "Phase 2");

    // Verify tickets were created with correct IDs (sort by ticketId for stable order)
    const taskRes = await req(`/api/projects/${data.projectId}/tasks`, { cookie: superCookie });
    assert.equal(taskRes.status, 200);
    const tasks = (await taskRes.json()).sort((a: any, b: any) => a.ticketId.localeCompare(b.ticketId));
    assert.equal(tasks[0].ticketId, "IMP-1");
    assert.equal(tasks[0].title, "Task one");
    assert.equal(tasks[0].priority, "HIGH");
    assert.equal(tasks[1].ticketId, "IMP-2");
    assert.equal(tasks[1].type, "BUG");
    assert.equal(tasks[2].ticketId, "IMP-3");
    assert.equal(tasks[2].assigneeId, "u_ayse");
    assert.equal(tasks[3].ticketId, "IMP-4");
    assert.equal(tasks[3].sprintId, null);
  });

  it("rejects import with missing project name", async () => {
    const res = await req("/api/projects/import", {
      method: "POST", cookie: superCookie,
      body: { sprints: [{ name: "S1" }], tasks: [] },
    });
    assert.equal(res.status, 400);
  });

  it("rejects import with invalid prefix", async () => {
    const res = await req("/api/projects/import", {
      method: "POST", cookie: superCookie,
      body: { project: { name: "X", prefix: "x" }, sprints: [{ name: "S1" }], tasks: [] },
    });
    assert.equal(res.status, 400);
  });

  it("rejects import with no sprints", async () => {
    const res = await req("/api/projects/import", {
      method: "POST", cookie: superCookie,
      body: { project: { name: "X", prefix: "XX" }, sprints: [], tasks: [] },
    });
    assert.equal(res.status, 400);
  });

  it("rejects import from non-admin", async () => {
    const res = await req("/api/projects/import", {
      method: "POST", cookie: member1,
      body: { project: { name: "X", prefix: "XX" }, sprints: [{ name: "S1" }], tasks: [] },
    });
    assert.ok(res.status === 401 || res.status === 403, `expected 401 or 403, got ${res.status}`);
  });
});
