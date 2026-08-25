// Offline backup: SQLite .backup() (consistent even under WAL) plus the
// uploaded media directory. Run via `npm run backup`; writes to WEB/backups/.
import { mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openLocalDb, DATA_DIR, PROJECT_ROOT } from "../src/db/local";

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(PROJECT_ROOT, "backups", stamp);
mkdirSync(outDir, { recursive: true });

// Consistent snapshot of the database file.
const db = openLocalDb();
await db.backup(join(outDir, "ticket-manager.db"));
db.close();

// Attachments live outside the database file; copy them next to it.
const uploads = join(DATA_DIR, "uploads");
try {
  cpSync(uploads, join(outDir, "uploads"), { recursive: true });
} catch {
  console.log("[backup] no uploads directory, skipping media copy");
}

console.log(`[backup] wrote ${outDir}`);
console.log("[backup] keep at least the most recent copy on a different disk.");
