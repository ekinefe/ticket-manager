import type { Context } from "hono";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Lazy cleanup so the map cannot grow unbounded in a long-running process.
function prune(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyFor: (c: Context) => string;
}

/**
 * Fixed-window in-memory rate limiter. Single-node only by design; if the
 * server is ever scaled horizontally this must move to a shared store.
 * Returns a Hono middleware that answers 429 once the window budget is used.
 */
export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context, next: () => Promise<void>) => {
    const now = Date.now();
    prune(now);
    const key = opts.keyFor(c);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      await next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      const retry = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("retry-after", String(retry));
      return c.json({ error: `Too many requests, retry in ${retry}s` }, 429);
    }
    await next();
  };
}

export function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "local"
  );
}
