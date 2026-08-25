import type { AppDB } from "./db/client";

declare global {
  interface Env {
    DB: AppDB;
    APP_URL: string;
    MAIL_FROM: string;
    MAIL_TRANSPORT: "resend" | "file";
    RESEND_API_KEY?: string;
    BETTER_AUTH_SECRET?: string;
    OSV_PACKAGES?: string;
  }
}

export {};
