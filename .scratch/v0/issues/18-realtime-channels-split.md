Status: resolved
Type: task
Blocked by: 05, 15

Split `REALTIME_CHANNELS` into its own pure-string module so the frontend
can import channel names without dragging server-side code into the
browser bundle.

## Background

15's landing hit a build failure: importing `REALTIME_CHANNELS` (a value
export) from `plugin/server.ts` made esbuild follow the import into
`plugin/lib/token-store.ts` (a Node-only module using `node:crypto`),
which fatally errored the browser bundle for the frontend.

Workaround shipped in 15: `share-popover.tsx` inlines the literal string
`"tokens-changed"` with a comment pointing back to `REALTIME_CHANNELS`.

## Fix

- Create `plugin/lib/realtime-channels.ts` exporting `REALTIME_CHANNELS`
  as `as const` string map with no runtime deps.
- `plugin/server.ts` re-exports from there so any existing importer keeps
  working.
- `plugin/share-popover/share-popover.tsx` (and any future frontend
  consumer) imports from `lib/realtime-channels.ts` directly and drops
  the inlined string + comment.

## Verify

- `tsc --noEmit` clean.
- `bb plugin build .` clean.
- Frontend bundle string-check: `tokens-changed` still present in
  `dist/app.js`; `dist/app.js` contains no code from `token-store.ts`
  (grep for `HMAC`, `node:crypto`, `createHmac` — all should be absent
  from the frontend bundle).

Small ticket — one session.

## Comments

## Answer

Done. `REALTIME_CHANNELS` now lives in its own pure-string module and both
frontend consumers import it directly; the `node:crypto` token store no longer
leaks into the browser bundle.

### Changes

- **New `plugin/lib/realtime-channels.ts`** — exports `REALTIME_CHANNELS` as an
  `as const` string map (`tokensChanged: "tokens-changed"`,
  `workerChanged: "worker-changed"`). No imports, no runtime deps.
- **`plugin/server.ts`** — dropped the inline `REALTIME_CHANNELS` definition;
  now `import`s it from `./lib/realtime-channels` (for use in the plugin body)
  and `export { REALTIME_CHANNELS } from "./lib/realtime-channels"` so existing
  backend importers keep working (backward compat).
- **`plugin/share-popover/share-popover.tsx`** — removed the inlined
  `TOKENS_CHANGED_CHANNEL = "tokens-changed"` const + workaround comment; imports
  `REALTIME_CHANNELS` from `../lib/realtime-channels.js` and subscribes with
  `REALTIME_CHANNELS.tokensChanged`.
- **`plugin/nav-panel/tokens-panel.tsx`** — same removal; now uses
  `REALTIME_CHANNELS.tokensChanged` and `REALTIME_CHANNELS.workerChanged` (the
  latter replacing a second inlined `"worker-changed"` literal).

### On folding in `worker-changed`

Checked `plugin/worker-lifecycle/worker-lifecycle.ts` — it does **not** export a
separate `"worker-changed"` channel string. It only references the name in
comments and broadcasts via the `publishStatus` callback wired in `server.ts`
(`bb.realtime.publish(REALTIME_CHANNELS.workerChanged, status)`). The channel
was already part of `REALTIME_CHANNELS`, so nothing to fold — but the module now
owns both channels and `tokens-panel.tsx`'s inlined `"worker-changed"` literal
was migrated to the constant for consistency.

### Verify (all green)

- `tsc --noEmit` — clean.
- `bb plugin build .` — clean (emits `dist/app.js`, `dist/server.js`, …).
- `grep dist/app.js`: `tokens-changed` ×1, `worker-changed` ×1 — both present.
- `grep dist/app.js`: `node:crypto`, `HMAC`, `createHmac` — all 0 (still present
  in `dist/server.js`, confirming the node-only code is server-bundle-only).
