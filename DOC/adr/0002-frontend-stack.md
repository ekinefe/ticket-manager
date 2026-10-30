# ADR 0002: Frontend stack after the client split

Status: proposed · Date: 2026-10-30 · Ticket: "Arch: decide on React/TypeScript for the frontend"

## Context

The client is vanilla ES modules with template strings and no build step (`DOC/vite-ts-react-evaluation.md` has the full cost/benefit). The big files are now split (`board.js` 1979 -> 1055 + a 924-line task modal, `admin.js` 1086 -> 40 + one file per tab, `dashboard.js` 842 -> 510 + widgets/charts), so a migration no longer means untangling one giant file. Budget is $0; Vite, React and TypeScript are free, but a build step adds CI/deploy complexity on Cloudflare.

## Decision (proposed)

1. **Stay vanilla for now.** Nothing in the current UI is blocked by it, and a rewrite of ~5.5k lines competes with the settings page, workspaces and the API/AI work.
2. **Add type safety cheaply:** JSDoc types plus `// @ts-check` and `tsc --noEmit` over `client/` (no build step, no new runtime dependency; `typescript` is already a dev dependency of the server).
3. **Use `/settings` as the decision point.** It is a new page with forms only. Build it in the same vanilla style first; if it feels painful (state sync, forms, validation), start Vite + TS + React with the *next* new page behind the existing router instead of rewriting old pages.
4. If React is adopted later, migrate route by route and keep the domain/API boundaries from ADR 0001 (the API types can be shared from `domains/*/dto.ts`).

## Consequences

- No new dependencies or build pipeline now; deploy stays "static assets + Worker".
- Type checking on the client arrives incrementally (file by file with `// @ts-check`).
- The React question is deferred, not dropped: revisit after `/settings` and the first workspace UI.
