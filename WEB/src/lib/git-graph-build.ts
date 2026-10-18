// Pure helpers behind the Git graph: which branches to read, which branch each
// commit belongs to, and a parents-after-children ordering. No network access.

export interface BuildCommit {
  sha: string;
  parents: string[];
  message: string;
  branch: string | null;
}

/**
 * Default branch first, then the branches recent PRs were merged INTO (the
 * integration branches that hold the newest work), then the heads of open PRs,
 * then everything else in the order GitHub listed them. GitHub lists branches
 * alphabetically, so taking the first N would hide the newest work.
 */
export function pickBranches<T extends { name: string; isDefault: boolean }>(
  all: T[],
  pulls: { base: string; head: string; state: string }[],
  max: number
): T[] {
  const byName = new Map(all.map((b) => [b.name, b]));
  const out: T[] = [];
  const add = (name: string) => {
    const b = byName.get(name);
    if (b && !out.includes(b)) out.push(b);
  };
  for (const b of all) if (b.isDefault) add(b.name);
  const baseCount = new Map<string, number>();
  for (const p of pulls) baseCount.set(p.base, (baseCount.get(p.base) ?? 0) + 1);
  [...baseCount].sort((a, b) => b[1] - a[1]).forEach(([name]) => add(name));
  for (const p of pulls) if (p.state === "open" || p.state === "draft") add(p.head);
  for (const b of all) add(b.name);
  return out.slice(0, max);
}

const PR_MERGE = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/;

/**
 * Give every commit a branch name:
 *  1. first-parent chain from each branch tip (default branch first);
 *  2. for "Merge pull request #N from owner/branch" commits, the merged side
 *     (second parent's first-parent chain) was made on that branch — this names
 *     the commits of feature branches that were deleted after the merge;
 *  3. anything still unnamed takes the branch of a named child commit.
 */
export function labelBranches(
  commits: BuildCommit[],
  branches: { name: string; sha: string }[],
  pullHeadByNumber: Map<number, string> = new Map()
): void {
  const bySha = new Map(commits.map((c) => [c.sha, c]));

  const walk = (start: string | undefined, name: string) => {
    let cur = start ? bySha.get(start) : undefined;
    while (cur && cur.branch === null) {
      cur.branch = name;
      cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
    }
  };

  for (const b of branches) walk(b.sha, b.name);

  // `commits` is newest-first, so outer merges are handled before inner ones.
  for (const c of commits) {
    if (c.parents.length < 2) continue;
    const m = PR_MERGE.exec(c.message);
    if (!m) continue;
    const name = pullHeadByNumber.get(Number(m[1])) ?? m[2];
    walk(c.parents[1], name);
  }

  // Fallback: inherit from a child that names this commit as a parent.
  const children = new Map<string, BuildCommit[]>();
  for (const c of commits) for (const p of c.parents) children.set(p, [...(children.get(p) ?? []), c]);
  for (const c of commits) {
    if (c.branch !== null) continue;
    const kids = children.get(c.sha) ?? [];
    const firstParentKid = kids.find((k) => k.parents[0] === c.sha && k.branch);
    c.branch = (firstParentKid ?? kids.find((k) => k.branch))?.branch ?? null;
  }
}

/**
 * Newest first, but never a parent above its child (so the graph lanes stay
 * connected even when commit dates are out of order, e.g. after a rebase).
 * `sortDate` breaks ties between independent commits.
 */
export function orderCommits<T extends { sha: string; parents: string[] }>(
  commits: T[],
  sortDate: (c: T) => number
): T[] {
  const inSet = new Set(commits.map((c) => c.sha));
  const pendingChildren = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) if (inSet.has(p)) pendingChildren.set(p, (pendingChildren.get(p) ?? 0) + 1);
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  let ready = commits.filter((c) => !pendingChildren.get(c.sha));
  const out: T[] = [];
  while (ready.length) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if (sortDate(ready[i]) > sortDate(ready[best])) best = i;
    const [c] = ready.splice(best, 1);
    out.push(c);
    for (const p of c.parents) {
      if (!inSet.has(p)) continue;
      const n = (pendingChildren.get(p) ?? 1) - 1;
      pendingChildren.set(p, n);
      if (n === 0) ready.push(bySha.get(p)!);
    }
  }
  return out;
}
