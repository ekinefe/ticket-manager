import type { Hono } from "hono";
import { requestCtx, requireProjectRole } from "../access/index";
import { guard } from "../../shared/route";
import { subscribe, unsubscribe } from "../../shared/realtime";

export function registerStreamRoutes(app: Hono, env: Env): void {
  // Server-Sent Events stream: clients get a "ticket-changed" nudge whenever
  // any ticket in the project is created, updated or deleted. The payload is
  // deliberately minimal — clients re-fetch the board rather than diffing.
  app.get("/api/projects/:id/stream", (c) =>
    guard(c, async () => {
      const projectId = c.req.param("id") as string;
      const ctx = await requestCtx(c, env);
      await requireProjectRole(ctx.db, ctx.user, projectId);

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let client: ReadableStreamDefaultController<Uint8Array> | undefined;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller;
          subscribe(projectId, controller);
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
            } catch {
              /* closed */
            }
          }, 30_000);
          // Clean up when the client disconnects (tab close, navigation).
          c.req.raw.signal.addEventListener("abort", () => {
            if (heartbeat) clearInterval(heartbeat);
            if (client) unsubscribe(projectId, client);
          });
        },
        cancel() {
          if (heartbeat) clearInterval(heartbeat);
          if (client) unsubscribe(projectId, client);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    })
  );
}
