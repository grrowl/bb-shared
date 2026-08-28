Status: resolved
Type: task
Blocked by: 08

Rewrite the SPA's index.html on delivery to guests, injecting a small
script + style that hides owner-only chrome.

- Set `document.documentElement.dataset.bbGuest = "1"`.
- CSS hides:
  - `[data-testid="app-sidebar-primary-actions"]`
  - `[aria-label="Settings"]`
  - `.plugin-nav-sidebar-items` (plugin nav rows)
  - `[aria-label="New thread"]`
- Selector list pinned in a constants file; audited against SPA build.
- Only rewrites HTML responses (Content-Type text/html).
- Only for guest requests (has valid token).

Ship a CI check that greps the **built bb SPA** (from a pinned bb-repo
checkout — track the bb version in a `BB_VERSION` file in this repo)
for each selector, to catch drift across bb version bumps. Fails CI if
a selector disappears.

## Comments

## Answer

Shipped the guest chrome shim as a post-dispatch pipeline stage plus a CI
selector-pin.

### Files

- `worker/src/chrome-selectors.ts` (new) — single source of truth. Each
  selector carries a `css` (used in the injected `<style>`) and a `probe`
  (the stable substring the CI check greps for). Exports `buildShimHtml()` /
  `buildShimCss()`.
- `worker/src/stages/chrome-shim.ts` (new) — `chromeShimStage(inner)`
  decorates the terminal dispatch stage; `injectGuestChrome(response)` does
  the rewrite. Uses Workers-native streaming `HTMLRewriter` when present
  (edge runtime — no buffering), falling back to an equivalent string
  insertion where it's absent (node / vitest / CI). Only `text/html` guest
  responses are touched; JSON/JS/CSS and non-guest (no-token) responses pass
  through byte-for-byte.
- `worker/src/worker.ts` — wired as `chromeShimStage(dispatchStage(router))`.
  It's a **decorator**, not a trailing array entry: `dispatchStage`
  short-circuits with `respond`, so a plain post-dispatch stage would never
  run. This composes cleanly with 09's `responseFiltersStage` (which handles
  the bootstrap JSON endpoints itself and `cont`s HTML through to dispatch).
- `worker/tests/chrome-shim.test.ts` (new) — 19 tests: guest HTML gets the
  shim in `<head>`; non-guest unchanged; JSON/JS/CSS untouched; content-type
  gating; malformed HTML (no `<head>`, no `<html>`, empty, junk) degrades
  gracefully without throwing.
- `scripts/check-chrome-selectors.mjs` (new) — zero-dep CI pin. Reads the
  probes out of `chrome-selectors.ts` and greps a built SPA
  (`dist/**/*.{js,html}` by default; `--ext` overrides for a source tree).
  Exits 1 with a per-selector MISSING message on drift, 0 when all present.
- `BB_VERSION` (new) — pins the audited bb build (`0.0.1` @ `31a190d`).

### Selector corrections (verified against bb @ 31a190d)

Two of the ticket's literal selectors do **not** match the current bb SPA;
kept verbatim they would have produced a green CI and a shim that hides
nothing. Corrected and documented in `chrome-selectors.ts`:

- `.plugin-nav-sidebar-items` (a CSS *class*) → `[data-testid=
  "plugin-nav-sidebar-items"]`. bb renders this as a `data-testid`
  (`PluginNavSidebarItems.tsx`), not a class.
- `[aria-label="Settings"]` (exact) → `[aria-label^="Settings"]`. The
  Settings button's aria-label is dynamic — `"Settings (⌘,)"` when a
  shortcut is bound (`AppSidebar.tsx`), so exact match fails in the common
  case. `[aria-label="New thread"]` → `[aria-label^="New thread"]` for the
  same shortcut/split-view reason. `[data-testid=
  "app-sidebar-primary-actions"]` kept as-is (confirmed present).

This is the drift the ticket exists to catch — logged here so a future bump
that "fixes" the selectors back to the literal list gets a second look.

### Verification

- `tsc --noEmit` in `worker/` — clean (exit 0).
- `vitest run` — 157 passed (7 files), incl. the 19 new tests.
- `wrangler deploy --dry-run` — builds (29.87 KiB / 8.48 KiB gzip).
- `check-chrome-selectors.mjs` — run against the bb checkout source
  (`/tmp/claude/bb-research/bb/apps/app/src --ext tsx,ts,html`, since that
  checkout has no `dist/`): scans 1260 files, all 4 probes present, exit 0.
  Drift path exercised with a synthetic missing probe: exit 1 with the
  MISSING report. In production CI, invoke against a built SPA:
  `node scripts/check-chrome-selectors.mjs path/to/bb/apps/app/dist`.

### Notes

- HTMLRewriter path can't be unit-tested in the node vitest env (the global
  is absent and `@cloudflare/vitest-pool-workers` isn't installed); the tests
  cover the string-fallback path, which injects the identical block, so the
  observable contract is the same on the edge.
- `worker/src/worker.ts` is shared with 09/10 (both landed their stages
  during this ticket); my change is the two-line import + dispatch wrap and
  the diagram comment.
