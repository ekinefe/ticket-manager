import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { app, seed, cleanup, userCookie, PROJECT_ID } from "./helpers.ts";

let adminCookie = "";

before(async () => {
  await seed();
  adminCookie = await userCookie("u_admin");
});

after(async () => {
  await cleanup();
});

describe("request body validation", () => {
  const targets: Array<[string, string]> = [
    ["POST", `/api/projects/${PROJECT_ID}/tasks`],
    ["POST", `/api/projects/${PROJECT_ID}/sprints`],
    ["PATCH", `/api/projects/${PROJECT_ID}`],
    ["POST", "/api/tasks/bulk-delete"],
    ["PATCH", "/api/me/language"],
  ];

  for (const [method, path] of targets) {
    for (const bad of ["null", "[]", "42", '"text"', "{not json"]) {
      it(`${method} ${path} rejects body ${bad} with 400`, async () => {
        const raw = await app.request(path, {
          method,
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: bad,
        });
        assert.equal(raw.status, 400);
      });
    }
  }
});
