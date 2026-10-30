import { rateLimit } from "./ratelimit";

// Strict per-client limiter for invitation creation (abuse containment).
// One instance, so project invitations and admin invites share a budget.
export const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyFor: (c) => `invite:${c.req.header("x-forwarded-for") ?? "local"}`,
});
