import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { labelBranches, orderCommits, pickBranches } from "../src/lib/git-graph-build.ts";

const c = (sha: string, message: string, ...parents: string[]) => ({ sha, parents, message, branch: null as string | null });

describe("pickBranches", () => {
  const all = ["alpha", "beta", "dev", "feat/open-one", "gamma", "main", "zeta"].map((name) => ({ name, sha: name, isDefault: name === "main" }));
  it("puts the default branch first, then PR bases, then open PR heads, then the rest", () => {
    const pulls = [
      { base: "dev", head: "feat/a", state: "closed" },
      { base: "dev", head: "feat/b", state: "closed" },
      { base: "main", head: "dev", state: "closed" },
      { base: "dev", head: "feat/open-one", state: "open" },
    ];
    assert.deepEqual(pickBranches(all, pulls, 4).map((b) => b.name), ["main", "dev", "feat/open-one", "alpha"]);
  });
  it("does not let alphabetical order hide the newest work", () => {
    const names = pickBranches(all, [{ base: "zeta", head: "x", state: "closed" }], 2).map((b) => b.name);
    assert.deepEqual(names, ["main", "zeta"]);
  });
});

describe("labelBranches", () => {
  it("names commits of a feature branch that was deleted after its PR merge", () => {
    // dev: m2 (merge PR #7 from me/feat/login) -> m1; feature chain f2 -> f1 -> m1
    const commits = [
      c("m2", "Merge pull request #7 from me/feat/login", "m1", "f2"),
      c("f2", "feat(login): button", "f1"),
      c("f1", "feat(login): form", "m1"),
      c("m1", "init"),
    ];
    labelBranches(commits, [{ name: "dev", sha: "m2" }]);
    assert.deepEqual(commits.map((x) => x.branch), ["dev", "feat/login", "feat/login", "dev"]);
  });

  it("prefers the PR's real head name over the one in the merge message", () => {
    const commits = [c("m", "Merge pull request #9 from me/renamed", "a", "b"), c("b", "x", "a"), c("a", "root")];
    labelBranches(commits, [{ name: "main", sha: "m" }], new Map([[9, "feat/real-name"]]));
    assert.equal(commits[1].branch, "feat/real-name");
  });

  it("leaves no commit unnamed when a named child exists", () => {
    const commits = [c("tip", "work", "mid"), c("mid", "no-label-chain", "base"), c("base", "root")];
    labelBranches(commits, [], new Map());
    assert.deepEqual(commits.map((x) => x.branch), [null, null, null]); // nothing to inherit from
    const named = [c("t", "m", "x", "y"), c("y", "side", "x"), c("x", "root")];
    named[0].branch = "dev";
    labelBranches(named, [], new Map());
    assert.ok(named.every((n) => n.branch));
  });
});

describe("orderCommits", () => {
  it("never puts a parent above its child, even with out-of-order dates", () => {
    const list = [c("parent", "p"), c("child", "c", "parent")];
    const date: Record<string, number> = { parent: 200, child: 100 }; // parent looks newer (rebase)
    const out = orderCommits(list, (x) => date[x.sha]);
    assert.deepEqual(out.map((x) => x.sha), ["child", "parent"]);
  });
  it("is newest-first for independent commits and keeps every commit", () => {
    const list = [c("a", "a"), c("b", "b"), c("d", "d")];
    const date: Record<string, number> = { a: 1, b: 3, d: 2 };
    assert.deepEqual(orderCommits(list, (x) => date[x.sha]).map((x) => x.sha), ["b", "d", "a"]);
  });
});
