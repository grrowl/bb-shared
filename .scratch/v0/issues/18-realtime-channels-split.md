Status:
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
