import type { Context } from "hono";
import { ApiError } from "./http";

// Error boundary for Hono route handlers: ApiError becomes its JSON status,
// anything else is logged and returned as a 500.
export async function guard(c: Context, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return c.json({ error: e.message }, e.status as 400);
    console.error(e);
    return c.json({ error: "Internal server error" }, 500);
  }
}

export async function readBody<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ApiError(400, "Invalid JSON body");
  }
}
