Status: resolved
Type: task

Scaffold the bb-shared plugin package.

- `plugins/bb-shared/` structure per bb plugin conventions.
- `plugin.json` manifest with backend + frontend entry points.
- Backend entry with `bb.rpc.register()` skeleton and RPC contract
  types (implementations stubbed with `throw new Error("not implemented")`).
- Frontend entry with empty component tree that loads cleanly.
- Build config that produces a loadable plugin bundle.
- `bb plugin install` from this repo works; plugin loads in the SPA
  without errors.

RPC contract (types only in this issue; implementations follow):

- `mintToken({ label? }): { token, url }`
- `listTokens(): Token[]`
- `renameToken(id, label): void`
- `deleteToken(id): void`
- `addShare(token_id, thread_id, project_id, perm): void`
- `removeShare(token_id, thread_id): void`
- `updateShare(token_id, thread_id, perm): void`
- `getWorkerStatus(): { url?, healthy: bool }`

Refs: `plugins/tasks/` and `plugins/automations/` in the bb repo as
templates.

## Comments

## Answer

Scaffold delivered at `plugin/`. Bootstrapped with `bb plugin new shared`
(bb 0.40.0 is installed on this host) then rewritten to match the ticket.

- `plugin/package.json` — bb manifest (`bb.server`, `bb.app`, branding
  `Link`, engines `bb>=0.40`, `bbPluginSdk>=0.4.21`). Kept the scaffold's
  shadcn devDependency set so downstream UI (issues 15, 16) has `Button`,
  `AlertDialog`, dropdowns, etc. available.
- `plugin/server.ts` — full RPC contract via `defineRpcContract`:
  `mintToken`, `listTokens`, `renameToken`, `deleteToken`, `addShare`,
  `removeShare`, `updateShare`, `getWorkerStatus`. Every handler is
  `throw new Error("not implemented: <name>")` with typed return
  annotations so filling the bodies won't touch call sites. Also exports
  `Token`/`Share`/`Perm`/`WorkerStatus` types (SPEC §"Data model") and
  `REALTIME_CHANNELS` (`tokens-changed`, `worker-changed`).
- `plugin/app.tsx` — three empty surfaces registered:
  `app.slots.navPanel` (`/plugins/shared/tokens`),
  `app.slots.experimental_threadHeaderAction`,
  `app.slots.commandPaletteAction` ("Share this thread"). Panel renders a
  placeholder; header action renders `null`; palette action is a no-op.
- `plugin/tsconfig.json` — inherited from scaffold. `tsc --noEmit` passes.
- `plugin/dist/` — `bb plugin build .` produced
  `server.{js,meta.json}` + `app.{js,css,meta.json}`.
- Verified end-to-end: `bb plugin install <path> --yes` reports
  `shared@0.1.0 running`. Uninstalled after the check.

`plugin/README.md` documents install + local-dev commands and the map from
this scaffold to downstream tickets.

Pointer: `~/grrowl/bb-shared/plugin/`.
