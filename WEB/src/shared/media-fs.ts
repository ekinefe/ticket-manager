import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import type { MediaStorage } from "./media";

// Filesystem media storage for local development (replaces R2). Persists
// uploaded attachments under DATA_DIR/uploads. Never imported in the Worker
// bundle (node:fs is not available there).
export function createFsStorage(dir: string): MediaStorage {
  mkdirSync(dir, { recursive: true });
  return {
    async put(key, data, contentType) {
      writeFileSync(join(dir, key), Buffer.from(data));
    },
    async get(key) {
      try {
        const body = readFileSync(join(dir, key));
        return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, contentType: mime(extname(key)) };
      } catch {
        return null;
      }
    },
    async remove(key) {
      try {
        unlinkSync(join(dir, key));
      } catch {
        /* already absent */
      }
    },
    async list() {
      return readdirSync(dir);
    },
  };
}

export function fsMtime(dir: string, key: string): number {
  try {
    return statSync(join(dir, key)).mtimeMs;
  } catch {
    return 0;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function mime(ext: string): string | null {
  return MIME_BY_EXT[ext] ?? null;
}
