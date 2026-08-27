Status: resolved
Type: task
Blocked by: 04

Share affordance from an open thread:

1. `experimental_threadHeaderAction` — "Share" icon-button in the thread
   header. Click → portalled popover.
2. Popover contents:
   - Existing tokens listed with quick "Add this thread as read | write"
     action per token.
   - "Mint new share" at the bottom (with `[read | write]` toggle;
     copies URL on create).
   - Link to management panel.
3. `commandPaletteAction` "Share this thread" — `isAvailable(ctx => !!ctx.threadId)`,
   `run(ctx)` opens the same popover.

- Uses `useRpc()` for backend calls.
- Uses `useRealtime()` to reflect changes made elsewhere.

Refs: `plugins/tasks/app.tsx`, `plugins/side-chat/app.tsx` in bb repo.

## Comments

## Answer

Delivered the owner-facing Share affordance from an open thread. New files:

- `plugin/components/ui/popover.tsx` — vendored from bb's `@bb/popover`
  registry entry (only the plugin-scoped `usePortalScopeProps` import differs).
- `plugin/share-popover/share-popover.tsx` — the popover: existing-tokens
  list with per-token `read | write` quick-add buttons (greyed out when the
  thread is already shared on that token with an equal-or-broader perm), a
  "Mint new share" section that toggles perm, calls `mintToken` +
  `addShare` in sequence, writes the returned URL to the clipboard, and
  flashes a status line. Bottom link routes to the `tokens` nav panel via
  `useBbNavigate().toPluginPanel("tokens")`.
- `plugin/share-popover/open-bus.ts` — a tiny module-level bus so the
  `commandPaletteAction.run()` (which fires outside any React tree) can ask
  the mounted `ShareHeaderAction` to open its popover — a single anchored
  popover shared between both entry points.

Edited files: `plugin/app.tsx` (replaced the `ShareHeaderAction` stub with
the real component, wired the palette `run` to `requestShareOpen`),
`plugin/tsconfig.json` (added `share-popover` to `include`).

Realtime: subscribes to the `tokens-changed` channel and refetches. The
channel string is inlined with a comment pointing to `REALTIME_CHANNELS`
in `server.ts` — a value import would drag the server module and its
`node:crypto`-using token store into `app.js` (esbuild refuses to bundle
node builtins into the browser bundle). The type imports for
`Token`, `Perm`, and `rpcContract` still come from `server.ts`.

Verification:

- `./node_modules/.bin/tsc --noEmit` — clean.
- `bb plugin build .` — clean; produces `dist/app.js` (25 KB) and
  `dist/server.js`. Bundle search confirms every expected UI string is
  present.

Surprises:

- `bb plugin build` failed at first because `import { REALTIME_CHANNELS,
  type Perm } from "../server.js"` counted as a value import — esbuild
  followed it into `lib/token-store.ts` and tripped on `node:crypto`.
  Splitting the constant off resolved it without touching `server.ts`
  (agent 05's territory).
- No `Popover` primitive was vendored in the scaffold, so I pulled the
  shared-ui source verbatim. `@radix-ui/react-popover` is already a
  devDependency.
