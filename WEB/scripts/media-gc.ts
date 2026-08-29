// Removes uploaded media files that are no longer referenced by any ticket
// description. Run via `npm run media:gc`. Files newer than 7 days are kept
// regardless, to avoid deleting attachments of tickets still being edited.
//
// Local-only tool: opens the local better-sqlite3 DB (so it stays compileable /
// runnable in the Node dev environment) and uses the same MediaStorage
// abstraction the app does for listing/removing attachments.
import { join } from "node:path";
import { createLocalDb, DATA_DIR } from "../src/db/local";
import { tasks } from "../src/db/schema";
import { createFsStorage, fsMtime } from "../src/lib/media-fs";

const GRACE_MS = 7 * 86_400_000;
const UPLOAD_DIR = join(DATA_DIR, "uploads");

const db = createLocalDb();
const storage = createFsStorage(UPLOAD_DIR);

const descriptions = await db.select({ description: tasks.description }).from(tasks);

const referenced = new Set<string>();
const re = /\/media\/uploads\/([A-Za-z0-9._-]+)/g;
for (const row of descriptions) {
  const desc = row.description ?? "";
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(desc)) !== null) referenced.add(m[1]);
}

let deleted = 0;
let kept = 0;
const now = Date.now();
for (const name of await storage.list()) {
  if (referenced.has(name)) { kept++; continue; }
  const age = now - fsMtime(UPLOAD_DIR, name);
  if (age < GRACE_MS) { kept++; continue; }
  await storage.remove(name);
  deleted++;
}

console.log(`[media:gc] referenced: ${referenced.size}, kept: ${kept}, deleted: ${deleted}`);
