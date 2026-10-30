# ADR 0001: Modular, domain-based structure (tenant-ready)

Status: accepted (implemented in PRs #60-#76) · Date: 2026-10-30 · Ticket: TM-83

## Context

`WEB/src/app.ts` is about 3300 lines with roughly 70 routes, and `client/js/pages/board.js` about 1900 lines. A change in one feature can break another. We also plan workspaces (tenants), a settings page, API tokens and AI helpers. Budget stays $0 (Cloudflare Workers + D1, no new paid services).

Inspiration: *Laravel Beyond CRUD* (domains, actions, DTOs, query builders, states, view models). The ideas carry over; Eloquent models and collections do not (Drizzle has no model classes), so we use plain functions and types.

## Decision

### Layout

```
WEB/src/
  app.ts                  wiring only: middleware + mount each domain's routes
  shared/                 db, http helpers, ratelimit, sanitize
  domains/<name>/
    routes.ts             Hono routes: parse, call an action, return JSON
    actions/              one function per use case (createTicket, moveTicket, ...)
    queries/              Drizzle query functions (visibleTo(ctx), ...)
    dto.ts                request/response types (+ validation later)
    states.ts / enums.ts  rules, allowed transitions, permission names
    index.ts              the ONLY public surface of the domain
  cron/                   jobs call domain actions
```

Domains: `tickets`, `projects`, `sprints`, `access`, `reports`, `accounts`, `notifications`, plus `github` (webhook, repo link, graph) and `settings` (app settings, cron trigger) that turned out to be their own concerns; `workspaces` is added later.

### Rules

1. Dependency direction: `routes -> actions -> queries -> db`. Never backwards.
2. A domain imports another domain only through its `index.ts`.
3. Permission checks live in `access`; other domains call it.
4. Every action and query takes `ctx` (user, role, later `workspaceId`), built by one middleware. Tenant isolation then becomes one filter in the query layer, not a rewrite.
5. Routes stay thin: no business logic and no direct Drizzle calls.
6. Moves are behaviour-neutral: tests green before and after, one domain per PR.

### Tenant model (target, not built yet)

- `workspace` owns projects; `workspace_member` links users. Projects list, sidebar and search only show the signed-in user's workspaces.
- A super admin sees all workspaces in `/admin` only, with an access-audit entry for support access.
- Existing data migrates into one default workspace.

### Frontend

Stay vanilla ES modules for now. Split `board.js` into `board/` (lane, card, task-modal, drag, state) and `admin.js` per tab. React/TypeScript is a separate later decision (see `DOC/vite-ts-react-evaluation.md`).

## Order of work

Characterization tests -> skeleton + `ctx` -> sprints (pilot) -> reports -> tickets -> projects/access -> accounts/notifications -> shrink `app.ts` -> DTOs/strict TS -> frontend split -> boundary check. Tickets are in Sprint 2 with the `architecture` label.

## Consequences

- Good: changes stay local to a domain; tenant isolation has one place to live; new features (settings, tokens, AI) are written in the new structure.
- Cost: a long refactor, and a period where `lib/` and `domains/` coexist. Mitigated by small PRs and the test suite (173 tests).
- Open: Zod vs hand-written validation, and a boundary-check tool, both need a dependency decision.

## As built (differences from the plan)

- Route handlers were moved mechanically: each domain has `routes.ts` (thin), `actions/*.ts` (use cases taking `ctx` + an `Input` with params/query/body), `dto.ts` (request body types). Queries are only split out where reused (sprints, ticket positions); the rest still lives next to the action that uses it.
- `ctx` is built lazily by `requestCtx(c, env)`; `publicCtx` and `optionalCtx` cover public and optional-session routes. `workspaceId` is `null` until workspaces exist.
- Validation is hand-written (`readBody` rejects non-object JSON; actions check fields). Zod was not added (new dependency).
- `tests/boundaries.test.ts` enforces the import rules (index-only cross-domain imports, `shared/` never imports a domain, layers one-way) with a small scanner instead of dependency-cruiser.
- Known wart: access actions import `applyPasswordReset` from accounts while accounts routes use `requestCtx` from access (a runtime cycle through the barrels, only used inside functions). Fix when `ctx` moves to `shared/`.
