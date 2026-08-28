Status: open
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
