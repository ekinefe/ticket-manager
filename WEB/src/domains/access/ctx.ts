import type { Context } from "hono";
import { getSessionUser, type SessionUser } from "./rbac";

// Per-request context handed to actions and queries. `workspaceId` is null
// until workspaces exist; once they do, the query layer filters on it in one
// place instead of every route (see DOC/adr/0001-modular-domains.md).
export interface Ctx {
  env: Env;
  db: Env["DB"];
  user: SessionUser;
  workspaceId: string | null;
}

// Resolved lazily (public routes have no session) and memoised per request.
const cache = new WeakMap<Request, Promise<Ctx>>();

export function requestCtx(c: Context, env: Env): Promise<Ctx> {
  let p = cache.get(c.req.raw);
  if (!p) {
    p = getSessionUser(c.req.raw, env).then((user) => ({ env, db: env.DB, user, workspaceId: null }));
    cache.set(c.req.raw, p);
  }
  return p;
}

// For public routes (login flows, setup) that have no signed-in user.
export type PublicCtx = Pick<Ctx, "env" | "db">;
export const publicCtx = (env: Env): PublicCtx => ({ env, db: env.DB });

// For routes that work with or without a session (e.g. shared ticket links).
export type OptionalCtx = PublicCtx & { user: SessionUser | null };
export async function optionalCtx(c: Context, env: Env): Promise<OptionalCtx> {
  const user = await getSessionUser(c.req.raw, env).catch(() => null);
  return { env, db: env.DB, user };
}
