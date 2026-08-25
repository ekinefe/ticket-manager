import { hashPassword } from "better-auth/crypto";
import { createHash } from "node:crypto";
import { openLocalDb } from "../src/db/local";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const daysAgo = (n: number) => now - n * DAY;

function q(v: string | number | null): string {
  if (v === null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface SeedUser {
  id: string;
  name: string;
  email: string;
  role: "SUPER_ADMIN" | "ADMIN" | "USER";
  password: string;
}

const USERS: SeedUser[] = [
  { id: "usr_admin", name: "Ekin", email: "ekin@plannedlost.dev", role: "SUPER_ADMIN", password: "admin123!" },
  { id: "usr_ayse", name: "Ayse", email: "ayse@plannedlost.dev", role: "USER", password: "member123!" },
  { id: "usr_mehmet", name: "Mehmet", email: "mehmet@plannedlost.dev", role: "USER", password: "member123!" },
  { id: "usr_deniz", name: "Deniz", email: "deniz@plannedlost.dev", role: "ADMIN", password: "admin123!" },
];

interface SeedProject {
  id: string;
  name: string;
  prefix: string;
  seq: number;
}

const PROJECTS: SeedProject[] = [
  { id: "prj_pln", name: "PlannedLost", prefix: "PLN", seq: 12 },
  { id: "prj_wce", name: "Web Cache Engine", prefix: "WCE", seq: 6 },
];

const MEMBERS: [string, string, "ADMIN" | "MEMBER"][] = [
  ["prj_pln", "usr_admin", "ADMIN"],
  ["prj_pln", "usr_ayse", "MEMBER"],
  ["prj_pln", "usr_mehmet", "MEMBER"],
  ["prj_pln", "usr_deniz", "MEMBER"],
  ["prj_wce", "usr_admin", "ADMIN"],
  ["prj_wce", "usr_mehmet", "MEMBER"],
  ["prj_wce", "usr_deniz", "MEMBER"],
];

interface SeedTask {
  projectId: string;
  n: number;
  title: string;
  status: string;
  assignee?: string;
  createdDaysAgo: number;
  history?: { status: string; atDaysAgo: number }[];
}

const TASKS: SeedTask[] = [
  { projectId: "prj_pln", n: 1, title: "Proje iskeletini kur", status: "DONE", assignee: "usr_admin", createdDaysAgo: 20,
    history: [{ status: "IN_PROGRESS", atDaysAgo: 18 }, { status: "UNDER_REVIEW", atDaysAgo: 16 }, { status: "MERGED", atDaysAgo: 15 }, { status: "DEPLOYED", atDaysAgo: 15 }, { status: "TEST", atDaysAgo: 14 }, { status: "DONE", atDaysAgo: 13 }] },
  { projectId: "prj_pln", n: 2, title: "Kanban surukle-birak destegi", status: "IN_PROGRESS", assignee: "usr_ayse", createdDaysAgo: 9 },
  { projectId: "prj_pln", n: 3, title: "Davet e-postasi HTML sablonu", status: "IN_PROGRESS", assignee: "usr_mehmet", createdDaysAgo: 7 },
  { projectId: "prj_pln", n: 4, title: "Ticket ID sayaci atomik guncellemesi", status: "UNDER_REVIEW", assignee: "usr_ayse", createdDaysAgo: 6 },
  { projectId: "prj_pln", n: 5, title: "Gunluk ozet cron isi", status: "MERGED", assignee: "usr_admin", createdDaysAgo: 5 },
  { projectId: "prj_pln", n: 6, title: "Resend entegrasyonu", status: "DEPLOYED", assignee: "usr_admin", createdDaysAgo: 4 },
  { projectId: "prj_pln", n: 7, title: "Canli ortam bildirim testi", status: "TEST", assignee: "usr_mehmet", createdDaysAgo: 2 },
  { projectId: "prj_pln", n: 8, title: "Rol matrisi dokumantasyonu", status: "TODO", createdDaysAgo: 1 },
  { projectId: "prj_pln", n: 9, title: "MailHog docker-compose dosyasi", status: "TODO", assignee: "usr_ayse", createdDaysAgo: 1 },
  { projectId: "prj_pln", n: 10, title: "Bugun kapanan ornek bilet", status: "DONE", assignee: "usr_ayse", createdDaysAgo: 3,
    history: [{ status: "IN_PROGRESS", atDaysAgo: 2 }, { status: "UNDER_REVIEW", atDaysAgo: 1 }, { status: "DEPLOYED", atDaysAgo: 0.5 }, { status: "DONE", atDaysAgo: 0.2 }] },
  { projectId: "prj_wce", n: 1, title: "LRU cache cikarma politikasi", status: "IN_PROGRESS", assignee: "usr_mehmet", createdDaysAgo: 8 },
  { projectId: "prj_wce", n: 2, title: "Cache invalidation API ucu", status: "TODO", createdDaysAgo: 4 },
  { projectId: "prj_wce", n: 3, title: "Benchmark senaryolari", status: "TODO", assignee: "usr_mehmet", createdDaysAgo: 2 },
  { projectId: "prj_wce", n: 4, title: "Ilk surum release notu", status: "DONE", assignee: "usr_admin", createdDaysAgo: 30,
    history: [{ status: "DONE", atDaysAgo: 25 }] },
];

async function main(): Promise<void> {
  const db = openLocalDb();
  const statements: string[] = [];

  for (const u of USERS) {
    const hash = await hashPassword(u.password);
    statements.push(
      `INSERT OR IGNORE INTO user (id, name, email, email_verified, role, created_at, updated_at) VALUES (${q(u.id)}, ${q(u.name)}, ${q(u.email)}, 1, ${q(u.role)}, ${daysAgo(30)}, ${now});`
    );
    statements.push(
      `INSERT OR IGNORE INTO account (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at) VALUES ('acc_${u.id}', ${q(u.id)}, 'credential', 'local:credential', ${q(u.id)}, ${q(hash)}, ${daysAgo(30)}, ${now});`
    );
  }

  for (const p of PROJECTS) {
    statements.push(
      `INSERT OR IGNORE INTO projects (id, name, prefix, current_ticket_sequence, created_at) VALUES (${q(p.id)}, ${q(p.name)}, ${q(p.prefix)}, ${p.seq}, ${daysAgo(35)});`
    );
  }

  for (const [projectId, userId, role] of MEMBERS) {
    statements.push(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (${q(projectId)}, ${q(userId)}, ${q(role)});`
    );
  }

  let actSeq = 0;
  const activity = (
    taskId: string,
    actorId: string,
    eventType: string,
    oldStatus: string | null,
    newStatus: string | null,
    createdAt: number
  ) =>
    `INSERT OR IGNORE INTO activity_log (id, task_id, actor_id, event_type, old_status, new_status, created_at) VALUES ('act_${++actSeq}', ${q(taskId)}, ${q(actorId)}, ${q(eventType)}, ${oldStatus ? q(oldStatus) : "NULL"}, ${newStatus ? q(newStatus) : "NULL"}, ${createdAt});`;

  for (const t of TASKS) {
    const project = PROJECTS.find((p) => p.id === t.projectId)!;
    const taskId = `tsk_${project.prefix.toLowerCase()}_${t.n}`;
    const ticketId = `${project.prefix}-${t.n}`;
    const creator = t.assignee ?? "usr_admin";
    const createdAt = daysAgo(t.createdDaysAgo);

    statements.push(
      `INSERT OR IGNORE INTO tasks (id, project_id, ticket_id, title, description, status, assignee_id, created_by, position, created_at, updated_at) VALUES (${q(taskId)}, ${q(t.projectId)}, ${q(ticketId)}, ${q(t.title)}, NULL, ${q(t.status)}, ${t.assignee ? q(t.assignee) : "NULL"}, ${q(creator)}, ${t.n}, ${createdAt}, ${now});`
    );
    statements.push(activity(taskId, creator, "CREATED", null, "TODO", createdAt));

    let prev = "TODO";
    for (const h of t.history ?? []) {
      statements.push(activity(taskId, t.assignee ?? "usr_admin", "STATUS_CHANGED", prev, h.status, daysAgo(h.atDaysAgo)));
      prev = h.status;
    }
  }

  statements.push(
    `INSERT OR IGNORE INTO invitations (id, project_id, email, token_hash, invited_role, expires_at, accepted_at, created_by, created_at) VALUES ('inv_pending', 'prj_pln', 'yeni-uye@plannedlost.dev', ${q(sha256("demo-invite-token"))}, 'MEMBER', ${now + 48 * HOUR}, NULL, 'usr_admin', ${now - HOUR});`
  );
  statements.push(
    `INSERT OR IGNORE INTO invitations (id, project_id, email, token_hash, invited_role, expires_at, accepted_at, created_by, created_at) VALUES ('inv_expired', 'prj_pln', 'gecmis@plannedlost.dev', ${q(sha256("expired-token"))}, 'MEMBER', ${daysAgo(1)}, NULL, 'usr_admin', ${daysAgo(3)});`
  );

  db.exec("DELETE FROM activity_log;\nDELETE FROM invitations;\n");
  db.exec(statements.join("\n"));

  console.log("Seed tamamlandi.");
  console.log("Kullanicilar:");
  for (const u of USERS) console.log(`  ${u.email} / ${u.password} (${u.role})`);
  console.log("Bekleyen davet linki token'i: demo-invite-token");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
