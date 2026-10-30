// Enforces the module rules from DOC/adr/0001-modular-domains.md without an
// extra dependency: a small import scanner over src/.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const importRe = /(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

interface Edge { from: string; to: string }
const edges: Edge[] = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(importRe)) {
    const target = normalize(join(dirname(file), m[1]));
    edges.push({ from: relative(SRC, file).split(sep).join("/"), to: relative(SRC, target).split(sep).join("/") });
  }
}

const domainOf = (p: string) => /^domains\/([^/]+)\//.exec(p)?.[1];
const bad = (list: string[]) => assert.deepEqual(list, [], list.join("\n"));

describe("module boundaries", () => {
  it("a domain imports another domain only through its index", () => {
    bad(edges
      .filter((e) => {
        const a = domainOf(e.from), b = domainOf(e.to);
        return a && b && a !== b && !/^domains\/[^/]+\/index$/.test(e.to);
      })
      .map((e) => `${e.from} -> ${e.to}`));
  });

  it("code outside domains (app, cron, server) imports domains only through their index", () => {
    bad(edges
      .filter((e) => !domainOf(e.from) && domainOf(e.to) && !/^domains\/[^/]+\/index$/.test(e.to))
      .map((e) => `${e.from} -> ${e.to}`));
  });

  it("shared/ never imports from a domain", () => {
    bad(edges.filter((e) => e.from.startsWith("shared/") && domainOf(e.to)).map((e) => `${e.from} -> ${e.to}`));
  });

  it("layers point one way: routes -> actions -> queries (never backwards)", () => {
    bad(edges
      .filter((e) =>
        (e.from.includes("/queries/") && (e.to.includes("/actions/") || /routes$/.test(e.to))) ||
        (e.from.includes("/actions/") && /routes$/.test(e.to)))
      .map((e) => `${e.from} -> ${e.to}`));
  });
});
