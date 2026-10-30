import type { Hono } from "hono";
import { requestCtx } from "../access/index";
import { guard } from "../../shared/route";
import { dashboardStats, getReports } from "./actions/reports";

export function registerReportRoutes(app: Hono, env: Env): void {
  app.get("/api/reports", (c) =>
    guard(c, async () => c.json(await getReports(await requestCtx(c, env), (k) => c.req.query(k))))
  );

  app.get("/api/dashboard/stats", (c) =>
    guard(c, async () => c.json(await dashboardStats(await requestCtx(c, env), (k) => c.req.query(k))))
  );
}
