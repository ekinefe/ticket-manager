import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type AppDB = BetterSQLite3Database<typeof schema>;

export const getDb = (db: unknown) => db as AppDB;
