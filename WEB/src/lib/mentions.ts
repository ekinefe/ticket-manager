import { user } from "../db/schema";
import { getDb, type AppDB } from "../db/client";
import { createNotification, type NotificationType } from "./in-app-notify";

const MENTION_ID_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;
const MENTION_NAME_RE = /@([A-Za-z][A-Za-z0-9_-]{0,30})/g;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

export async function notifyMentionedUsers(opts: {
  db: AppDB;
  text: string;
  actorId: string;
  taskId: string;
  projectId: string;
  messagePrefix: string;
}): Promise<void> {
  const plain = stripHtml(opts.text);

  const userIds = new Set<string>();
  let m: RegExpExecArray | null;

  // Format 1: @[Name](userId) — the app's own mention format
  while ((m = MENTION_ID_RE.exec(plain)) !== null) {
    const uid = m[2].trim();
    if (uid && uid !== opts.actorId) userIds.add(uid);
  }

  // Format 2: @Name — plain text mentions (fallback)
  if (userIds.size === 0) {
    const nameSet = new Set<string>();
    while ((m = MENTION_NAME_RE.exec(plain)) !== null) {
      nameSet.add(m[1].toLowerCase());
    }
    if (nameSet.size > 0) {
      const allUsers = await getDb(opts.db)
        .select({ id: user.id, name: user.name })
        .from(user);
      for (const u of allUsers) {
        if (nameSet.has(u.name.toLowerCase()) && u.id !== opts.actorId) {
          userIds.add(u.id);
        }
      }
    }
  }

  if (userIds.size === 0) return;

  const notified = new Set<string>();
  for (const uid of userIds) {
    if (notified.has(uid)) continue;
    notified.add(uid);
    await createNotification({
      db: opts.db,
      userId: uid,
      actorId: opts.actorId,
      type: "MENTIONED" as NotificationType,
      taskId: opts.taskId,
      projectId: opts.projectId,
      message: `${opts.messagePrefix} mentioned you`,
    }).catch((e) => console.error("mention notification failed:", e));
  }
}
