import { ApiError } from "../http";
import { sendViaResend } from "./resend";

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

// The local ".mail-out" file transport depends on node:fs (and, transitively,
// better-sqlite3 via local DB paths). Those cannot run on Workers, so the
// shared getTransport() never imports it directly — that would put node:fs in
// the Worker bundle. Instead the Node-only bootstrap (server/main.ts) registers
// the factory here, keeping the file transport entirely out of the Worker
// import graph.
type FileTransportFactory = () => MailTransport;
let fileTransportFactory: FileTransportFactory | null = null;

export function registerFileTransport(factory: FileTransportFactory): void {
  fileTransportFactory = factory;
}

export async function getTransport(env: Env): Promise<MailTransport> {
  if (env.MAIL_TRANSPORT === "resend") {
    if (!env.RESEND_API_KEY) throw new ApiError(500, "RESEND_API_KEY is not configured");
    return {
      kind: "resend",
      send: (msg) => sendViaResend(env.RESEND_API_KEY!, env.MAIL_FROM, msg),
    };
  }

  if (!fileTransportFactory) {
    throw new ApiError(500, "File transport is not registered (local dev only)");
  }
  return fileTransportFactory();
}

