import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuery } from "../src/lib/search.ts";
import { canTransition, statusSlug, STATUSES, INSTANT_NOTIFY_STATUSES } from "../src/lib/status.ts";

describe("normalizeQuery", () => {
  it("lowercases and strips non-alphanumerics", () => {
    assert.equal(normalizeQuery("PLN-2"), "pln2");
    assert.equal(normalizeQuery("  Kanban Destegi! "), "kanbandestegi");
    assert.equal(normalizeQuery("--**--"), "");
  });
});

describe("status model", () => {
  it("has exactly seven ordered statuses", () => {
    assert.deepEqual(STATUSES, [
      "TODO", "IN_PROGRESS", "UNDER_REVIEW", "MERGED", "DEPLOYED", "TEST", "DONE",
    ]);
  });

  it("allows free transitions (undo-friendly drags)", () => {
    assert.equal(canTransition("TODO", "DONE"), true);
    assert.equal(canTransition("DONE", "TODO"), true);
  });

  it("maps statuses to template slugs and instant-notify set", () => {
    assert.equal(statusSlug("IN_PROGRESS"), "in-progress");
    assert.ok(INSTANT_NOTIFY_STATUSES.has("UNDER_REVIEW"));
    assert.ok(!INSTANT_NOTIFY_STATUSES.has("DONE"));
  });
});
