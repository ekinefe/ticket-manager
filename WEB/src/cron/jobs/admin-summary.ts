import { and, eq, gte, lt, sql } from "drizzle-orm";
import { activityLog, invitations, tasks, user } from "../../db/schema";
import { getDb } from "../../db/client";
import { listSuperAdminEmails } from "../../lib/rbac";
import { renderTemplate, htmlToText, statRow } from "../../lib/mail/templates";
import { getTransport } from "../../lib/mail";
import { runOnce, weekBounds, monthBounds } from "../guard";

export type SummaryPeriod = "daily" | "weekly" | "monthly";

const PERIOD_LABEL: Record<SummaryPeriod, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function periodBounds(period: SummaryPeriod, dateKey: string): { start: number; end: number } {
  if (period === "weekly") return weekBounds(dateKey);
  if (period === "monthly") return monthBounds(dateKey);
  const start = Date.parse(`${dateKey}T00:00:00Z`);
  return { start, end: start + 86_400_000 };
}

function rangeLabel(period: SummaryPeriod, start: number, end: number, dateKey: string): string {
  if (period === "daily") return dateKey;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${fmt(start)} to ${fmt(end - 1)}`;
}

/**
 * System-wide (all-projects) usage summary, sent only to SUPER_ADMIN users —
 * distinct from the per-project weekly report sent to project admins. Piggy-
 * backs on the existing daily/weekly cron triggers (see scheduler.ts) rather
 * than adding new ones, since the Workers Free plan caps cron triggers at 5
 * per account.
 */
export async function runAdminSummary(env: Env, period: SummaryPeriod, dateKey: string): Promise<void> {
  if (!(await runOnce(env, `admin_summary_${period}`, dateKey))) return;

  const recipients = await listSuperAdminEmails(env.DB);
  if (recipients.length === 0) return;

  const { start, end } = periodBounds(period, dateKey);
  const db = getDb(env.DB);

  const [{ newUsers }] = await db
    .select({ newUsers: sql<number>`count(*)` })
    .from(user)
    .where(and(gte(user.createdAt, new Date(start)), lt(user.createdAt, new Date(end))));

  const [{ createdTickets }] = await db
    .select({ createdTickets: sql<number>`count(distinct ${activityLog.taskId})` })
    .from(activityLog)
    .where(and(eq(activityLog.eventType, "CREATED"), gte(activityLog.createdAt, start), lt(activityLog.createdAt, end)));

  const [{ completedTickets }] = await db
    .select({ completedTickets: sql<number>`count(distinct ${activityLog.taskId})` })
    .from(activityLog)
    .where(and(eq(activityLog.newStatus, "DONE"), gte(activityLog.createdAt, start), lt(activityLog.createdAt, end)));

  const [{ openTickets }] = await db
    .select({ openTickets: sql<number>`count(*)` })
    .from(tasks)
    .where(sql`${tasks.status} != 'DONE'`);

  const [{ pendingInvites }] = await db
    .select({ pendingInvites: sql<number>`count(*)` })
    .from(invitations)
    .where(and(sql`${invitations.acceptedAt} is null`, gte(invitations.expiresAt, Date.now())));

  const statsRows =
    statRow("New users", newUsers) +
    statRow("Tickets created", createdTickets) +
    statRow("Tickets completed", completedTickets) +
    statRow("Currently open tickets (all projects)", openTickets) +
    statRow("Pending invitations", pendingInvites);

  const html = renderTemplate("admin-summary", {
    period_label: PERIOD_LABEL[period],
    range_label: rangeLabel(period, start, end, dateKey),
    stats_rows: statsRows,
    app_url: env.APP_URL,
  });

  const transport = await getTransport(env);
  await Promise.all(
    recipients.map((to) =>
      transport.send({
        to,
        subject: `${PERIOD_LABEL[period]} summary - Ticket Manager (${dateKey})`,
        html,
        text: htmlToText(html),
      })
    )
  );
}
