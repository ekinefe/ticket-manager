import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "../http";
import { sendViaResend } from "./resend";
import { MAIL_OUT_DIR } from "../../db/local";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  readonly kind: "resend" | "file";
  send(msg: MailMessage): Promise<void>;
}

function sanitize(s: string): string {
  return s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function getTransport(env: Env): MailTransport {
  if (env.MAIL_TRANSPORT === "resend") {
    if (!env.RESEND_API_KEY) throw new ApiError(500, "RESEND_API_KEY is not configured");
    return {
      kind: "resend",
      send: (msg) => sendViaResend(env.RESEND_API_KEY!, env.MAIL_FROM, msg),
    };
  }

  return {
    kind: "file",
    send: async (msg) => {
      mkdirSync(MAIL_OUT_DIR, { recursive: true });
      const name = `${Date.now()}-${sanitize(msg.to)}-${sanitize(msg.subject)}`;
      writeFileSync(join(MAIL_OUT_DIR, `${name}.html`), msg.html);
      writeFileSync(join(MAIL_OUT_DIR, `${name}.txt`), msg.text);
      console.log(`[mail] -> ${msg.to} : ${msg.subject} (.mail-out/${name}.html)`);
    },
  };
}
