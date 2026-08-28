Status: resolved
Type: task
Blocked by: 08

Worker response filters — intercept and reshape upstream JSON responses.

- `GET /api/v1/system/config`: strip `aiServices`, `keybindings`,
  `voiceTranscriptionEnabled`; keep theme + shell config.
- `GET /api/v1/sidebar-bootstrap`: filter `projects[].threads` to the
  token's shares; filter `sections` to allowed; replace `personalProject`
  with an empty-thread stub.
- `GET /api/v1/plugins`: return `{ plugins: [] }` (v0).
- `GET /api/v1/hosts`: return `[]`.
- `GET /api/v1/plugin-settings/*`: return empty.

Each filter takes upstream JSON + token scope + returns filtered JSON.
Unit tests per filter with realistic bb response fixtures.

Notes:

- Consumes the token-scope shape from 06's authz response; the
  interface is fixed in SPEC.md so no build dependency on 06 —
  parallelizable.
- **Share fixture capture with issue 11**: one snapshot of a live bb
  instance's responses + WS frames serves both this and the WS filter.
  Coordinate with 11's owner on fixture location.

## Comments

## Answer

Delivered `worker/src/stages/response-filters.ts` + `worker/tests/response-filters.test.ts`.

**Design.** Each endpoint gets a pure `(upstream, scope) → filtered` function;
`responseFiltersStage(router)` matches on `(method, path)` and either reshapes
upstream (dispatching through the tunnel first) or answers a constant without
ever touching the tunnel. Scope is `ctx.scope ?? EMPTY_SCOPE` — a null scope
(authz not yet resolved) denies everything and yields empty scoped responses.

Filters:

- `GET /api/v1/system/config` → `filterSystemConfig`: object-rest strips exactly
  the three named fields (`aiServices`, `keybindings`, `voiceTranscriptionEnabled`);
  everything else (theme/appearance, generalSettings, featureFlags, shell config)
  passes through. `defaultKeybindings`/`keybindingOverrides` are **kept** — the
  ticket names only `keybindings`.
- `GET /api/v1/sidebar-bootstrap` → `filterSidebarBootstrap`: drops projects with
  no share (not just their threads — a bare project leaks its name/existence),
  keeps only in-scope threads within survivors, filters `sections` to those that
  still group a surviving thread, and replaces `personalProject` with an inert
  stub (fixed `proj_personal` id, empty `sources`/`threads`). In-scope projects
  keep their `sources` on purpose — the guest is authorized for them and the SPA
  reads `sources` (`findLocalPathProjectSourceForHost`) to render the project.
- `GET /api/v1/plugins` → `{ plugins: [] }` (constant, no tunnel hop).
- `GET /api/v1/hosts` → `[]` (constant).
- `GET /api/v1/plugin-settings/*` → `{}` (constant). NB bb's real route is
  `/plugins/:id/settings`; the ticket pins this to `/plugin-settings/*`. Guests
  reach neither (empty inventory + 10's mutation gate) — this is belt-and-braces.

Only GETs are candidates; writes fall through to 10's mutation gate. Non-200 or
non-JSON upstream on a reshape path is passed through untouched (503/404/HTML
must reach the SPA as-is). Fixtures in the test are realistic instances of bb's
`server-contract` schemas (`system.ts`, `projects.ts`, `plugins.ts`).

**Wiring / coordination with 10.** The stage is inserted in `worker.ts` BEFORE
`dispatchStage` and AFTER 10's `authzStage` (which populates `ctx.scope`). 10
landed its worker.ts edits concurrently in the shared tree, so worker.ts now
holds both wirings interleaved and imports 10's still-untracked `authz.ts` /
`route-lockouts.ts`. To avoid a broken/muddy commit, **worker.ts is NOT staged
here** — it rides in 10's coordinated commit alongside those files, with my
`responseFiltersStage` import+call already in place. My commit is just the two
new self-contained files (+ this ticket), which build and test independently.

**Verify.** `tsc --noEmit` clean; `vitest run` 138/138 (26 new); `wrangler
deploy --dry-run` builds.
