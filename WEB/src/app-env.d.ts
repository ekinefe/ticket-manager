import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { AppDB } from "./db/client";
import type { MediaStorage } from "./lib/media";

declare global {
  interface Env {
    DB: AppDB;
    BUCKET?: R2Bucket;
    STORAGE: MediaStorage;
    APP_URL: string;
    MAIL_FROM: string;
    MAIL_TRANSPORT: "resend" | "file";
    RESEND_API_KEY?: string;
    BETTER_AUTH_SECRET?: string;
    OSV_PACKAGES?: string;
    // GitHub App (set via Admin > Settings, or as Worker secrets).
    GITHUB_APP_ID?: string;
    GITHUB_APP_PRIVATE_KEY?: string;
    GITHUB_WEBHOOK_SECRET?: string;
    GITHUB_BRANCH_CREATE?: string;
  }
}

export {};
