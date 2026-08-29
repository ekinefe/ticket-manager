import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";
import type { AppDB } from "./client";

// Cloudflare Workers entry point for the database layer. Receives the D1
// binding from the Worker env and returns a Drizzle client typed as AppDB so
// the rest of the app is identical to the local (better-sqlite3) path.
export function createD1Db(d1: D1Database): AppDB {
  return drizzle(d1, { schema }) as AppDB;
}
