import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard, inputOf, respond } from "../../shared/route";
import * as a from "./actions/media";
import { MEDIA_NAME_RE } from "./actions/media";

export function registerMediaRoutes(app: Hono, env: Env): void {
  app.post("/api/projects/:id/media", (c) =>
    guard(c, async () => respond(c, await a.uploadMedia(await requestCtx(c, env), inputOf(c)), 201))
  );

  // Serve uploaded media from the configured storage backend (R2 on Workers,
  // filesystem locally). Public by design: URLs are unguessable UUIDs.
  app.get("/media/uploads/:name", async (c) => {
    const name = c.req.param("name");
    if (!MEDIA_NAME_RE.test(name)) return c.notFound();
    const obj = await env.STORAGE.get(name);
    if (!obj) return c.notFound();
    return new Response(obj.body, {
      headers: {
        "content-type": obj.contentType ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  });
}
