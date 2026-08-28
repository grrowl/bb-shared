Status: resolved
Type: bug
Severity: high
Blocked by:
Found by: post-v0 adversarial review (2026-08-28)

Out-of-scope project reads: `/api/v1/projects/{p}` is allowed for any project.

SPEC §"Response filters" is correct: `GET /api/v1/projects/{p}` → "allow if any
share references `p`". The implementation ignores the scope check.

## The defect

- `plugin/authz/authz.ts:74` classifies EVERY `/api/v1/projects/*` as
  `non-thread`, and 151-153 returns `allowed: true` unconditionally — no check
  that the token has a share in `p`. `authz.test.ts:64` asserts this as
  intended.
- The worker's `matchResponseFilter` (`worker/src/stages/response-filters.ts`,
  ~170-191) filters only `/system/config` and `/sidebar-bootstrap` (plus
  constant `[]`/`{plugins:[]}` for `/plugins`, `/hosts`, `/plugin-settings`).
  There is NO filter for `/api/v1/projects/{p}`, so the real response is
  forwarded unshaped.

## Failure scenario

Guest requests `GET /api/v1/projects/{anyProjectId}` for a project never
granted to their token. They receive real metadata: project name, `sources`
(host filesystem paths), and its thread list — leaking project existence and
thread ids/titles across the whole instance.

## Latent escalation to verify

The thread-scope gate (`authz.ts:93`) matches only paths beginning
`/threads/`. Any thread route bb also serves under a project prefix (e.g.
`/api/v1/projects/{p}/threads/{t}`) classifies as `non-thread` → allowed →
unfiltered — a full out-of-scope thread-content read. `authz.test.ts:64` shows
project-nested thread paths are treated non-thread. **Verify against bb's
actual server-contract routes** whether thread content is reachable under a
`/projects/{p}/...` prefix; if so this is critical, not just a metadata leak.

## Fix direction

- Authz: `/api/v1/projects/{p}` allowed only if some share references `p`
  (use `project_scope`, already computed at 133). Deny otherwise.
- Worker: add a `/api/v1/projects/{p}` response filter (shape `threads`,
  `sections`, and strip `sources` to the token's scope) — parallels the
  sidebar-bootstrap filter.
- Reclassify any project-nested thread path as `thread` (extract `{t}` and run
  it through the thread-scope + perm gate) so the escalation path can't exist.

## Comments

## Answer

Authz decision fixed in `plugin/authz/authz.ts` (the out-of-scope read leak,
the critical part):

- `/projects` is removed from `NON_THREAD_PREFIXES`. `classifyPath` now returns
  a `project` kind for `/projects/{p}` (and subpaths), and `computeAuthz` allows
  it only if `p` is in `project_scope`, GET only. An out-of-scope
  `GET /api/v1/projects/{p}` is now denied, and the worker enforces the deny at
  `stages/authz.ts:195`.
- The latent escalation is closed: `classifyPath` matches a project-nested
  thread path (`/projects/{p}/threads/{t}`) as a `thread`, so it runs through
  the thread scope + perm gate instead of the project/non-thread branch. Tested.
- A bare `/projects` list (no id) now classifies as invalid → denied; a guest
  gets its scoped tree from `/sidebar-bootstrap`, not the raw list.

Worker-side filter now done too. `worker/src/stages/response-filters.ts` adds
`filterProjectDetail`, matched for `GET /api/v1/projects/{p}` (a single id
segment; the bare list and `/{p}/...` subpaths do not match). It strips
`sources` (host filesystem paths), keeps only in-scope threads, and keeps only
sections grouping a surviving thread, degrading closed for an out-of-scope or
malformed body. Trailing-slash variants normalize to the same match (issue 25).
Tests added; full worker suite 167/167 green, tsc clean.

Follow-up (separate, already noted in map.md): `filterSidebarBootstrap` keeps
`sources` on the in-scope projects it returns. That is the same class of leak
for the sidebar endpoint and should get the same `sources: []` treatment.
