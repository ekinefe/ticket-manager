import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import * as schema from "../db/schema";
import { getDb } from "../db/client";

export function createAuth(env: Env) {
  const db = getDb(env.DB);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    // Cloudflare git-integration previews get their own subdomain per branch
    // (e.g. dev-ticket-manager.gnrdigital.workers.dev). Without this wildcard,
    // Better Auth's origin check 403s every sign-in attempt made from a
    // preview deploy since only the production APP_URL would be trusted.
    trustedOrigins: [env.APP_URL, "https://*-ticket-manager.gnrdigital.workers.dev"],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "USER",
          input: false,
        },
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
      },
    },
  });
}
