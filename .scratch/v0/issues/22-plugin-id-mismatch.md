Status:
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
