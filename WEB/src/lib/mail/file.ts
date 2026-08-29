import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIL_OUT_DIR } from "../../db/local";
import type { MailMessage, MailTransport } from "./index";

function sanitize(s: string): string {
  return s.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// Local-dev-only transport: writes rendered mail to the .mail-out/ folder so
// it can be inspected without sending. Never imported in the Worker bundle.
export function createFileTransport(): MailTransport {
  return {
    kind: "file",
    send: async (msg: MailMessage) => {
      mkdirSync(MAIL_OUT_DIR, { recursive: true });
      const name = `${Date.now()}-${sanitize(msg.to)}-${sanitize(msg.subject)}`;
      writeFileSync(join(MAIL_OUT_DIR, `${name}.html`), msg.html);
      writeFileSync(join(MAIL_OUT_DIR, `${name}.txt`), msg.text);
      console.log(`[mail] -> ${msg.to} : ${msg.subject} (.mail-out/${name}.html)`);
    },
  };
}
