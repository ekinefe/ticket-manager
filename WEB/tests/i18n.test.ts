import { describe, it } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore plain JS module shared with the browser client
import en from "../client/js/locales/en.js";
// @ts-ignore plain JS module shared with the browser client
import tr from "../client/js/locales/tr.js";

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("client locales", () => {
  it("Turkish has exactly the English keys", () => {
    assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  });

  it("each key uses the same {placeholders} in both languages", () => {
    for (const k of Object.keys(en)) assert.deepEqual(vars(tr[k]), vars(en[k]), k);
  });
});
