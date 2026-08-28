Status: open
Type: bug
Severity: medium
Blocked by:
Found by: post-v0 adversarial review (2026-08-28)

Response-filter exact-match vs authz prefix-allow gap (trailing-slash bypass).

## The defect

- `worker/src/stages/response-filters.ts` (~176-191) matches filtered paths by
  EXACT string (`/api/v1/plugins`, `/api/v1/hosts`, `/api/v1/plugin-settings`).
- `plugin/authz/authz.ts` allows by PREFIX and normalizes trailing slashes away
  (`normalizePath` 76-87, `classifyPath` 97-101).

So `GET /api/v1/plugins/` or `/api/v1/hosts/` (trailing slash) is allowed by
authz, MISSES the exact-match filter, and is forwarded to real bb — disclosing
the real plugin inventory / host list the filters exist to suppress. The SPA's
own calls use the canonical path; a crafted guest request does not.

## Fix direction

Make the worker filter matcher normalize the same way authz does (strip
trailing slash, tolerate `/api/v1` prefix variants) so the allow surface and
the filter surface are defined by one shared normalizer. Ideally both sides
import the same `normalizePath`. Add tests for the trailing-slash variants of
every filtered endpoint.

## Comments

## Answer
