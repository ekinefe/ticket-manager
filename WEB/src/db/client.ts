import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

// Shared runtime-agnostic database type. The app code is written against D1's
// async Drizzle surface (select/insert/update/delete/transaction are all
// awaited). Local development wraps better-sqlite3 behind the same type so the
// rest of the codebase does not care which adapter is in use.
export type AppDB = DrizzleD1Database<typeof schema> & { $client: D1Database };

export const getDb = (db: unknown) => db as AppDB;
