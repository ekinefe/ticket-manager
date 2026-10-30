import type { R2Bucket } from "@cloudflare/workers-types";
import { ApiError } from "./http";

// Storage-agnostic media (attachment) layer. Local development persists to the
// filesystem; Cloudflare Workers persists to R2. The upload/serve/gc code uses
// this interface so nothing else knows (or cares) which backend is in use.

export interface MediaObject {
  body: ArrayBuffer;
  contentType: string | null;
}

export interface MediaStorage {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<MediaObject | null>;
  remove(key: string): Promise<void>;
  list(): Promise<string[]>;
}

// ---- Disabled (no backend configured) ----
// Used when no attachament store is configured (e.g. R2 not enabled yet on the
// Workers deploy). Uploads are rejected with a clear message instead of the
// whole app crashing. Remove this once a storage backend is provisioned.
export function createDisabledStorage(): MediaStorage {
  const disabled = () => {
    throw new ApiError(503, "File uploads are not yet configured on this deployment");
  };
  return {
    put: disabled,
    get: async () => null,
    remove: disabled,
    list: async () => [],
  };
}

// ---- R2 (Cloudflare Workers) ----

export function createR2Storage(bucket: R2Bucket): MediaStorage {
  return {
    async put(key, data, contentType) {
      await bucket.put(key, data, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: await obj.arrayBuffer(),
        contentType: obj.httpMetadata?.contentType ?? null,
      };
    },
    async remove(key) {
      await bucket.delete(key);
    },
    async list() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const listed = await bucket.list({ cursor, limit: 1000 });
        for (const o of listed.objects) names.push(o.key);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      return names;
    },
  };
}
