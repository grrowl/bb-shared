Status: resolved
Type: task
Blocked by: 17

**V0 BLOCKER** — flagged in 17's runbook, cross-verified by 04's
scaffold output.

bb mounts the plugin under id `shared` (from package name
`bb-plugin-shared`; bb strips the `bb-plugin-` prefix — confirmed by
04's install output `shared@0.1.0 running`). But SPEC + tickets
06/10/16 wrote the authz endpoint URL as
`/api/v1/plugins/bb-shared/http/authz` — that id doesn't exist at
runtime.

Impact: every guest request → worker calls a non-existent authz
endpoint → 404/401 → deny-closed → 403. Nothing works on a real first
run.

## Fix — accept `shared`, update all references

Simpler than renaming the plugin. Change every `bb-shared` occurrence
in a URL path to `shared` throughout the codebase. Keep `bb-shared` as
the project/repo name (only change URL segments).

- `plugin/authz/authz.ts` — endpoint route registration.
- `plugin/worker-lifecycle/*` — any embedded URLs.
- `worker/src/stages/authz.ts` — the authz call URL.
- `worker/src/*` — grep for any other embedded reference.
- SPEC.md — every mention of `bb-shared` in a URL path.
- `.scratch/v0/issues/06-authz-endpoint.md`,
  `10-mutation-gate.md` — URL references in ticket bodies.
- `docs/e2e-runbook.md` — any URL references.

## Verify

- `grep -r '/plugins/bb-shared/' plugin/ worker/` → 0 hits.
- `grep -r '/plugins/bb-shared/' SPEC.md docs/` → 0 hits (excluding
  project-name mentions).
- Plugin `tsc --noEmit` clean; `bb plugin build .` clean; vitest
  passes.
- Worker `tsc --noEmit` clean; vitest passes;
  `wrangler deploy --dry-run` builds.
- Fixture / mock URLs in tests updated where hardcoded.

Small ticket — mostly find-and-replace + a test fixture update.

## Comments

## Answer

Executed path (b): mount id is **`shared`** (confirmed — package name
`bb-plugin-shared`, bb strips the `bb-plugin-` prefix; matches 04's
`shared@0.1.0 running`). Changed every `bb-shared` URL segment to `shared`
throughout `plugin/`, `worker/`, `SPEC.md`, and `docs/`. Left `bb-shared` as
the project/repo name everywhere it means the project (package name, brand,
`@bb-shared/*` vendored packages, `bb-shared-worker`, etc.) — untouched.

**Functional fix** (the actual bug):
- `worker/src/stages/authz.ts` — `AUTHZ_ENDPOINT_PATH` constant now
  `/api/v1/plugins/shared/http/authz`. This is the string the worker pulls on
  every guest request; it previously hit a non-existent mount → deny-closed
  403 on every request.
- `worker/tests/authz.test.ts` — the hardcoded pathname assertion updated to
  `shared` (the test that pins the URL the worker calls).

**Doc/comment references updated:**
- `plugin/authz/authz.ts` — authz-URL comment; also fixed the stale
  `bb plugin token bb-shared` → `bb plugin token shared` (same id-mismatch
  class — that CLI arg is the mount id, would have failed provisioning).
- `plugin/share-popover/share-popover.tsx`, `plugin/nav-panel/tokens-panel.tsx`
  — `/plugins/shared/tokens` in registration comments.
- `worker/src/stages/authz.ts` — header-comment authz URL.
- `SPEC.md` §Owner UI — navPanel path `/plugins/shared/tokens`.
- `docs/e2e-runbook.md` — the "Drift" warning block, the nav-panel note, and
  the troubleshooting row were **reframed as resolved** (not blind-swapped —
  a literal swap would have made "worker calls X while plugin mounts X" read
  as a contradiction). They now document that ticket 22 aligned both to
  `shared`, with `shared`-based sanity-check curls.

Not touched: `.scratch/v0/issues/*` ticket bodies (06, 10, 16, 17, 20, etc.) —
outside the task's grep scope (`plugin/ worker/` + `SPEC.md docs/`); they are
historical records and 20 is editing some concurrently. No new `bb-shared` URL
refs from 20 were present at grep time.

**Verify — all green:**
- `grep -r '/plugins/bb-shared/' plugin/ worker/` → 0 hits.
- `grep -r '/plugins/bb-shared/' SPEC.md docs/` → 0 hits.
- `grep -rn 'plugins/bb-shared' plugin/ worker/ SPEC.md docs/` → 0 hits.
- plugin: `tsc --noEmit` clean; `vitest` 62/62 pass; `bb plugin build .` clean.
- worker: `tsc --noEmit` clean; `vitest` 158/158 pass;
  `wrangler deploy --dry-run` builds (29.77 KiB).
