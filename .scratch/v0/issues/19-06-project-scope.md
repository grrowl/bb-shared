Status:
Type: task
Blocked by: 06

Extend 06's `/authz` response to include project ids in each token's scope,
so the worker's `GuestScope.projectIds` can be populated correctly.

## Background

10's authz stage populates `ctx.scope: GuestScope { threadIds, projectIds }`
from the /authz response. `threadIds` comes from `thread_scope` directly.
`projectIds` was expected to come from `perm.project_id` — but 06's `perms`
entries are `{ thread_id, mode }` with no `project_id`. Result:
`projectIds` is always **empty today**.

Consumers of `projectIds`:

- **09 response filters** — needs `projectIds` to filter
  `sidebar-bootstrap`'s `projects[]` down to those the token grants any
  thread in.
- **11 WS frame filter** — needs `projectIds` to allow `project-detail`
  subscribes and `changed`/project passes.

Without this, guests see no projects in the sidebar and receive no
project-scoped realtime invalidations (breaking sidebar UX + refetch
correctness).

## Fix

Two shape options — pick whichever fits 06's existing shape best. Rec: (b).

- (a) Extend `perms` entries: `perm = { thread_id, project_id, mode }`.
  Adds project_id per share; per-share perm still lives on `thread_id`.
- (b) Add a separate `project_scope: string[]` field alongside
  `thread_scope`. 06 derives it as `unique(shares.map(s => s.project_id))`
  from the token's shares.

**Rec (b)** — matches the shape of `thread_scope`, avoids overloading perms
with a field that doesn't gate perm decisions.

Data source: `Share.project_id` (already in the token store per SPEC data
model — no store change).

## Deliver

- Update `plugin/authz/authz.ts` response shape: add `project_scope: string[]`
  to the response body, derived from token's shares.
- Update `plugin/authz/authz.test.ts` — assert `project_scope` correctness
  for single-share, multi-thread-same-project, multi-project cases.
- Update `worker/src/stages/authz.ts` (`scopeFromAuthz`) to read
  `project_scope` from the authz response (currently reads
  `perm.project_id if present`, which is forward-compatible but empty
  today).
- Update `worker/tests/authz.test.ts` if needed — a case asserting
  `projectIds` is populated.

## Verify

- plugin: `tsc --noEmit` clean, `bb plugin build .` clean, vitest passes
  including new project_scope cases.
- worker: `tsc --noEmit` clean, vitest passes, `wrangler deploy --dry-run`
  builds.

Small ticket — one session.

## Comments

## Answer
