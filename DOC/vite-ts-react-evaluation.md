# Evaluation: moving the client to Vite + TypeScript + React (TM-12)

Status: research note, no code changed. Written from the current codebase;
library/tooling claims are general knowledge and should be re-checked against
current docs before committing to a migration.

## Where we are

- Client is vanilla ES modules in `WEB/client/` (~5.5k lines, 4 shared files +
  11 page modules), no build step, no dependencies besides Chart.js from a CDN.
- Pages render with template strings (`root.innerHTML = ...`) and bind events
  by hand after each render; module-level variables hold board state.
- Served directly by Cloudflare static assets (`[assets] directory = "./client"`
  in `wrangler.toml`) with SPA fallback to `index.html`.
- The server (Hono) is already TypeScript and has a typecheck (`npm run check`).

## What the migration would buy

- **Type safety on the client**, including shared API types with the server.
- **Declarative rendering**: the hardest code today is `board.js` (~1.7k lines),
  where state, DOM strings and listeners must be kept in sync manually
  (e.g. lane counts going stale, TM-32, came from that).
- A component ecosystem (drag & drop, charts, i18n for TM-28, date pickers).
- Hot reload and tree-shaken bundles instead of a CDN script.

## What it would cost

- A rewrite of ~5.5k lines of UI; it cannot be done page-by-page without a
  temporary dual setup.
- New dependencies (Vite, React, TypeScript types, a router, probably a data
  layer) and a build step in CI and deploy (`wrangler.toml` assets would point to
  the Vite output dir).
- The rich-text editor is hand-built on `contentEditable`/`execCommand`; it would
  need re-implementing or replacing with a library (an extra dependency).
- Risk of regressions in the many hand-tuned interactions (drag/drop, SSE live
  updates, modals, autosave).

## Options

1. **Stay vanilla**, add JSDoc types + `// @ts-check` and `tsc --noEmit` on the
   client. Cheapest; gets most of the type-safety benefit.
2. **Vite + TypeScript, no React**: add a build step and TS but keep the
   rendering model. Moderate effort, moderate gain.
3. **Vite + TS + React**, migrating one route at a time behind the existing
   router (new pages in React, old ones untouched) until the vanilla client is
   gone. Highest gain, highest cost; best fit if i18n (TM-28), reports and a
   welcome page are all coming.

## Recommendation

If the roadmap keeps adding UI features, go with option 3 incrementally,
starting with a new page that does not exist yet (e.g. welcome page or reports)
so the build/deploy pipeline is proven before touching `board.js`. If the UI is
close to done, option 1 is the better return on effort. Decision needed from the
owner; nothing here is implemented.
