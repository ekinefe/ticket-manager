import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bucketStart, buildForecast, buildReport, type ReportTask } from "../src/domains/reports/index.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 14, 12); // Wed 2026-10-14

describe("bucketStart", () => {
  it("snaps to day / Monday / first of month (UTC)", () => {
    assert.equal(new Date(bucketStart(T0, "daily")).toISOString(), "2026-10-14T00:00:00.000Z");
    assert.equal(new Date(bucketStart(T0, "weekly")).toISOString(), "2026-10-12T00:00:00.000Z");
    assert.equal(new Date(bucketStart(T0, "monthly")).toISOString(), "2026-10-01T00:00:00.000Z");
  });
});

describe("buildForecast", () => {
  it("orders optimistic <= realistic <= pessimistic finish, with 3 scenarios at once", () => {
    const f = buildForecast([1, 2, 3, 6], 10, 40, Date.UTC(2026, 9, 12), "weekly");
    assert.equal(f.remaining, 30);
    assert.ok(f.optimistic.velocity > f.realistic.velocity && f.realistic.velocity > f.pessimistic.velocity);
    assert.ok(f.optimistic.periodsNeeded! < f.realistic.periodsNeeded!);
    assert.ok(f.realistic.periodsNeeded! < f.pessimistic.periodsNeeded!);
    assert.equal(f.optimistic.points.length, f.horizon);
    assert.ok(f.optimistic.points.every((p) => p <= 40));
  });

  it("reports 'never' when the pace is zero and 0 periods when nothing is left", () => {
    const stalled = buildForecast([0, 0, 0], 5, 9, T0, "weekly");
    assert.equal(stalled.realistic.periodsNeeded, null);
    assert.equal(stalled.realistic.finishDate, null);
    const finished = buildForecast([2, 3], 9, 9, T0, "weekly");
    assert.equal(finished.realistic.periodsNeeded, 0);
  });
});

describe("buildReport", () => {
  const mk = (id: string, status: string, created: number, extra: Partial<ReportTask> = {}): ReportTask => ({
    id, ticketId: id.toUpperCase(), title: id, status, assigneeId: "u1", projectPrefix: "TM",
    createdAt: created, updatedAt: created, dueDate: null, ...extra,
  });

  it("buckets created/completed, builds cumulative series and KPIs", () => {
    const tasks = [
      mk("a", "DONE", T0 - 3 * DAY),
      mk("b", "DONE", T0 - 2 * DAY),
      mk("c", "IN_PROGRESS", T0 - 1 * DAY, { dueDate: "2026-10-01" }),
      mk("d", "TODO", T0),
    ];
    const doneAt = new Map([["a", T0 - 2 * DAY], ["b", T0 - 1 * DAY]]);
    const r = buildReport({ tasks, doneAt, userNames: new Map([["u1", "Ada"]]), granularity: "daily", periods: 7, now: T0 });
    assert.equal(r.series.length, 7);
    assert.equal(r.series.at(-1)!.cumCreated, 4);
    assert.equal(r.series.at(-1)!.cumCompleted, 2);
    assert.equal(r.kpis.total, 4);
    assert.equal(r.kpis.done, 2);
    assert.equal(r.kpis.open, 2);
    assert.equal(r.kpis.inProgress, 1);
    assert.equal(r.kpis.overdue, 1);
    assert.equal(r.kpis.completionRate, 50);
    assert.equal(r.assignees[0].name, "Ada");
    assert.equal(r.assignees[0].completed, 2);
    assert.equal(r.completedList[0].ticketId, "B");
    assert.equal(r.forecast.remaining, 2);
  });

  it("handles an empty project", () => {
    const r = buildReport({ tasks: [], doneAt: new Map(), userNames: new Map(), granularity: "weekly", now: T0 });
    assert.equal(r.kpis.total, 0);
    assert.equal(r.kpis.completionRate, 0);
    assert.equal(r.forecast.remaining, 0);
  });
});
