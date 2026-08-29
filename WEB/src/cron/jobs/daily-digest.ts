import { and, asc, eq, gte, lt } from "drizzle-orm";
import { activityLog, projects, tasks } from "../../db/schema";
import { getDb } from "../../db/client";
import { listMemberEmails } from "../../lib/rbac";
import { renderTemplate, htmlToText, ticketRow, emptyRow } from "../../lib/mail/templates";
import { getTransport } from "../../lib/mail";
import { runOnce } from "../guard";

export async function runDailyDigest(env: Env, dateKey: string): Promise<void> {
  if (!(await runOnce(env, "daily_digest", dateKey))) return;

  const start = Date.parse(`${dateKey}T00:00:00Z`);
  const end = start + 86_400_000;
  const db = getDb(env.DB);
  const transport = await getTransport(env);

  const allProjects = await db.select({ id: projects.id, name: projects.name }).from(projects);

  for (const project of allProjects) {
    const closedTasks = await db
      .selectDistinct({ id: tasks.id, ticketId: tasks.ticketId, title: tasks.title })
      .from(activityLog)
      .innerJoin(tasks, eq(tasks.id, activityLog.taskId))
      .where(
        and(
          eq(tasks.projectId, project.id),
          eq(activityLog.newStatus, "DONE"),
          gte(activityLog.createdAt, start),
          lt(activityLog.createdAt, end)
        )
      );

    const wipTasks = await db
      .select({ id: tasks.id, ticketId: tasks.ticketId, title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.projectId, project.id), eq(tasks.status, "IN_PROGRESS")))
      .orderBy(asc(tasks.position));

    const url = (taskId: string) => `${env.APP_URL}/project/${project.id}?task=${taskId}`;
    const doneRows =
      closedTasks.map((t) => ticketRow(t.ticketId, t.title, url(t.id), "DONE")).join("") ||
      emptyRow("No tickets were completed today");
    const wipRows =
      wipTasks.map((t) => ticketRow(t.ticketId, t.title, url(t.id), "IN_PROGRESS")).join("") ||
      emptyRow("No tickets are currently in progress");

    const html = renderTemplate("digest-daily", {
      project: project.name,
      date: dateKey,
      done_count: String(closedTasks.length),
      done_rows: doneRows,
      wip_count: String(wipTasks.length),
      wip_rows: wipRows,
    });

    const recipients = await listMemberEmails(env.DB, project.id);
    await Promise.all(
      recipients.map((to) =>
        transport.send({
          to,
          subject: `Daily digest - ${project.name} (${dateKey})`,
          html,
          text: htmlToText(html),
        })
      )
    );
  }
}
