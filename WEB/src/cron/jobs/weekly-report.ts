import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { AppDB } from "../../db/client";
import { projects, tasks, activityLog } from "../../db/schema";
import { getDb } from "../../db/client";
import { listAdminEmails, listSuperAdminEmails } from "../../lib/rbac";
import { renderTemplate, htmlToText, statRow } from "../../lib/mail/templates";
import { getTransport } from "../../lib/mail";
import { runOnce, weekBounds } from "../guard";

export async function runWeeklyReport(env: Env, dateKey: string): Promise<void> {
  if (!(await runOnce(env, "weekly_report", dateKey))) return;

  const { start, end } = weekBounds(dateKey);
  const db = getDb(env.DB);
  const transport = await getTransport(env);

  const allProjects = await db.select({ id: projects.id, name: projects.name }).from(projects);
  const superAdmins = await listSuperAdminEmails(env.DB);

  for (const project of allProjects) {
    const created = await countActivity(env.DB, project.id, "CREATED", start, end);
    const deployed = await countStatus(env.DB, project.id, "DEPLOYED", start, end);
    const done = await countStatus(env.DB, project.id, "DONE", start, end);

    const wipRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.projectId, project.id), eq(tasks.status, "IN_PROGRESS")));
    const wip = Number(wipRows[0]?.count ?? 0);

    const statsRows =
      statRow("Created this week", created) +
      statRow("Deployed this week", deployed) +
      statRow("Completed this week", done) +
      statRow("Currently in progress", wip);

    const summary = `${deployed} ticket(s) were deployed and ${created} ticket(s) were created this week. ` +
      `${wip} ticket(s) are waiting in In Progress.`;

    const html = renderTemplate("digest-weekly", {
      project: project.name,
      week_start: new Date(start).toISOString().slice(0, 10),
      week_end: dateKey,
      stats_rows: statsRows,
      summary_sentence: summary,
      board_url: `${env.APP_URL}/project/${project.id}`,
    });

    const admins = await listAdminEmails(env.DB, project.id);
    const recipients = [...new Set([...superAdmins, ...admins])];

    await Promise.all(
      recipients.map((to) =>
        transport.send({
          to,
          subject: `Weekly report - ${project.name}`,
          html,
          text: htmlToText(html),
        })
      )
    );
  }
}

async function countActivity(
  db: AppDB,
  projectId: string,
  eventType: string,
  start: number,
  end: number
): Promise<number> {
  const rows = await getDb(db)
    .select({ count: sql<number>`count(distinct ${activityLog.taskId})` })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(activityLog.eventType, eventType),
        gte(activityLog.createdAt, start),
        lt(activityLog.createdAt, end)
      )
    );
  return Number(rows[0]?.count ?? 0);
}

async function countStatus(
  db: AppDB,
  projectId: string,
  status: string,
  start: number,
  end: number
): Promise<number> {
  const rows = await getDb(db)
    .select({ count: sql<number>`count(distinct ${activityLog.taskId})` })
    .from(activityLog)
    .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(activityLog.newStatus, status),
        gte(activityLog.createdAt, start),
        lt(activityLog.createdAt, end)
      )
    );
  return Number(rows[0]?.count ?? 0);
}
