import { user } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { requireProjectRole } from "../../access/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";

// Uploaded media keys are always `<uuid>.<ext>`, generated server-side (see
// the upload handler below). Enforcing that shape on lookup closes off path
// traversal on the filesystem storage backend (`../../.env`-style keys),
// where a raw `name` param would otherwise be joined straight into a path.
export const MEDIA_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{3,4}$/i;

const MEDIA_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

// Image/video uploads for ticket descriptions and comments.
export async function uploadMedia(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectRole(ctx.db, u, projectId);

  const form = await input.form();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "Missing file field");
  const ext = MEDIA_EXT[file.type];
  if (!ext) throw new ApiError(415, `Unsupported media type: ${file.type || "unknown"}`);
  if (file.size > MAX_MEDIA_BYTES) throw new ApiError(413, "File too large (max 100 MB)");

  const name = `${crypto.randomUUID()}.${ext}`;
  await ctx.env.STORAGE.put(name, await file.arrayBuffer(), file.type);
  return { url: `/media/uploads/${name}`, type: file.type, size: file.size };
}
