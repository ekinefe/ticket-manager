import { eq, inArray } from "drizzle-orm";
import { tasks, user, projects } from "../db/schema";
import { getDb } from "../db/client";
import { STATUS_LABELS, statusSlug, type Status } from "./status";
import { renderTemplate, htmlToText } from "./mail/templates";
import { getTransport } from "./mail";

export interface StatusChangeNotification {
  projectId: string;
  taskId: string;
  ticketId: string;
  taskTitle: string;
  oldStatus: Status;
  newStatus: Status;
  actorName: string;
}

export async function notifyStatusChanged(env: Env, change: StatusChangeNotification): Promise<void> {
  const db = getDb(env.DB);
  const [task] = await db
    .select({ createdBy: tasks.createdBy, assigneeId: tasks.assigneeId })
    .from(tasks)
    .where(eq(tasks.id, change.taskId));

  const recipientIds = [task?.createdBy, task?.assigneeId].filter((v): v is string => Boolean(v));
  if (recipientIds.length === 0) return;

  const recipients = await db
    .select({ email: user.email })
    .from(user)
    .where(inArray(user.id, recipientIds));
  const emails = [...new Set(recipients.map((r) => r.email))];
  if (emails.length === 0) return;

  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, change.projectId));

  const vars: Record<string, string> = {
    task_title: change.taskTitle,
    ticket_id: change.ticketId,
    project: project?.name ?? "",
    actor: change.actorName,
    old_status: STATUS_LABELS[change.oldStatus],
    new_status: STATUS_LABELS[change.newStatus],
    task_url: `${env.APP_URL}/project/${change.projectId}?task=${change.taskId}`,
  };

  const html = renderTemplate(`status-${statusSlug(change.newStatus)}`, vars);
  const transport = await getTransport(env);

  await Promise.all(
    emails.map((to) =>
      transport.send({
        to,
        subject: `[${change.ticketId}] ${STATUS_LABELS[change.newStatus]} - ${change.taskTitle}`,
        html,
        text: htmlToText(html),
      })
    )
  );
}
