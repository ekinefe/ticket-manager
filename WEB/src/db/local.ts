import { mkdirSync } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import type { AppDB } from "./client";

export const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
export const DATA_DIR = join(PROJECT_ROOT, "data");
export const MAIL_OUT_DIR = join(PROJECT_ROOT, ".mail-out");

export function openLocalDb(file = join(DATA_DIR, "ticket-manager.db")): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name)
  );

  const dir = join(PROJECT_ROOT, "migrations");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    db.exec(readFileSync(join(dir, name), "utf-8"));
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, Date.now());
    console.log(`migration applied: ${name}`);
  }
}

export function createLocalDb(file?: string): AppDB {
  return drizzle(openLocalDb(file), { schema }) as unknown as AppDB;
}
