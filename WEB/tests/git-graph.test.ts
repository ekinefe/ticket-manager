import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain browser module, pure function
import { layoutGraph } from "../client/js/pages/git-graph.js";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("git graph layout", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, maxLanes } = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    assert.equal(maxLanes, 1);
    assert.deepEqual(rows.map((r: any) => r.col), [0, 0, 0]);
  });

  it("puts a side branch in its own lane and joins it at the fork point", () => {
    // m2 merges feature f1 into main; both descend from m1.
    const { rows, maxLanes } = layoutGraph([c("m2", "m1", "f1"), c("f1", "m1"), c("m1", "m0"), c("m0")]);
    assert.equal(maxLanes, 2);
    const byCol = Object.fromEntries(rows.map((r: any) => [r.commit.sha, r.col]));
    assert.equal(byCol.m2, 0);
    assert.equal(byCol.f1, 1);
    assert.equal(byCol.m1, 0);
    // f1's own line curves from its lane (1) into main's lane (0) heading for m1
    const f1 = rows.find((r: any) => r.commit.sha === "f1");
    assert.ok(f1.segs.some((s: any) => s.x1 === 1 && s.x2 === 0 && s.y2 === 1));
  });

  it("starts a new lane for an unrelated branch tip", () => {
    const { rows } = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    assert.deepEqual(rows.map((r: any) => r.col), [0, 1, 0]);
  });
});
