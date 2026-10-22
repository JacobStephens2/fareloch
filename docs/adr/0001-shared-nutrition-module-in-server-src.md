# 0001 - The shared Nutrition module lives in the server source tree

Status: accepted (2026-10-04)

## Decision

The Nutrition module lives at `server/src/nutrition.ts`, and the client imports it across the repo (`../../server/src/nutrition` from `src/`). The module must import nothing.

## Context

The server, guest mode (`src/local-db.ts`) and the views all need the same nutrition math (issue #2). One source file has to be loadable from both packages.

A top-level shared folder looks tidier but breaks deploy. `server/tsconfig.json` sets `rootDir` to `./src`, and the `macros-api` systemd unit starts the server from `dist/index.js` (see `DEPLOYMENT.md`). If the server imported a file outside `server/src`, `tsc` would either reject it or widen `rootDir` and move the emitted entry point to `dist/server/src/index.js`.

The client side has no such constraint. Vite bundles a file outside `src/` without complaint, and the client `tsc --noEmit` type-checks it. This was prototyped in the #2 architecture review: client `tsc`, `vite build` and server `tsc` all passed with the client importing the server-side file.

## Consequences

- The module must stay import-free. The server compiles with ESM and needs `.js` suffixes on relative imports; the client resolves with `moduleResolution: bundler`. A module with no imports sidesteps the difference, and it keeps the module pure (no database, no localStorage, no DOM).
- Its test, `server/src/nutrition.test.ts`, runs under Vitest from the root package (`npm test`). `server/tsconfig.json` excludes `*.test.ts` so `tsc` does not emit tests to `dist` or need Vitest types.
- Do not "fix" the cross-package import by moving the file to a shared folder without also changing the server's `rootDir` and the systemd entry point.
