Status: resolved
Type: bug
Severity: critical
Blocked by:
Found by: post-v0 adversarial review (2026-08-28)

Authz allowlist is path-only; it must be per-(method, path), deny-by-default.

SPEC §"Mutation gate" is correct and unchanged: "Deny by default. Guest may
ONLY `POST /api/v1/threads/{t}/send` if `t` in scope AND perm == `write`.
Everything else returns 403." The implementation drifted from this.

## The defect

`plugin/authz/authz.ts` `computeAuthz`:

- **151-153** — for ANY path classified `non-thread`, returns
  `{ allowed: true }` regardless of HTTP method and regardless of perm. The
  method/perm check exists only in the thread branch (156-177).
- `NON_THREAD_PREFIXES` (74) = `["/plugin-settings", "/plugins", "/hosts",
  "/projects"]`, so `POST/PUT/PATCH/DELETE` to any `/api/v1/plugins/*`,
  `/projects/*`, `/hosts/*`, `/plugin-settings/*` is authorized.
- The worker has NO separate mutation-gate stage (`worker/src/worker.ts`
  pipeline 73-101). `responseFiltersStage` only intercepts GET
  (`response-filters.ts:174`); every non-GET falls through to dispatch and is
  forwarded verbatim. The only worker-side mutation deny is
  `GUEST_DENIED_RPC_RE = /^\/api\/v1\/plugins\/shared\/rpc/`
  (`worker/src/stages/authz.ts:113`) — it covers ONLY the `shared` plugin.

Ticket 10 ("Deny-by-default; explicit allowlist per (method, path)") was marked
resolved but built the method check for the thread branch only. `authz.test.ts`
asserts the broken behaviour, so it looked green.

## Failure scenarios

1. **read-guest → code execution.** A read-only guest POSTs
   `/api/v1/plugins/automations/rpc/<create>` (or `tasks`, etc.). Classified
   non-thread → allowed → worker forwards → local bb (no session/auth of its
   own, worker is the only gate) executes it. Automations run scheduled code.
2. `DELETE /api/v1/projects/{p}`, writes to `/api/v1/plugin-settings/*`, etc.
   — all authorized for any guest.

Also (was finding #4, MEDIUM, same root cause in the OTHER branch): the thread
branch (168-177) allows ANY mutating method/subpath on an in-scope thread for a
write guest — `DELETE /api/v1/threads/{t}`, `PATCH` config, `/abort`. SPEC
restricts write guests to `POST /threads/{t}/send` ONLY.

## Fix direction (allowlist deeper than path)

- Make the decision method-aware and deny-by-default. A mutating method
  (POST/PUT/PATCH/DELETE) is denied unless it matches the ONE allowlisted
  (method, path, perm) tuple: `POST /api/v1/threads/{t}/send`, `t` in scope,
  perm == write. Everything else mutating → 403.
- Non-thread paths: allow GET (worker response-filters shape them), deny all
  mutating methods. Confirm each non-thread prefix genuinely needs even GET.
- Consider adding an explicit worker-side mutation-gate stage as defence in
  depth, so a future authz regression can't reopen this (worker enforces the
  send-only rule independently of the plugin decision, like `GUEST_DENIED_RPC`
  already does for the shared plugin — generalise it).

## Open question for the owner (raised 2026-08-28)

Is method-level enough, or does `POST /threads/{t}/send` also need **body
filtering**? A write guest can currently put anything in the send body. If the
send payload can carry control fields (slash-commands, tool-approval,
provider/model overrides, attachments), method+path+perm is not sufficient and
we need a body allowlist (plain user-message text only, reject control fields).
Decide before implementing; if yes, it belongs in this ticket's scope.

## Tests

Replace the assertions in `authz.test.ts` / `worker/tests/authz.test.ts` that
currently encode the broken "non-thread always allowed" behaviour. Add: read
guest POST to another plugin's RPC → 403; DELETE project → 403; write guest
DELETE/PATCH thread → 403; write guest POST /send → 200. Iterate the bb
server-contract routes and assert deny-by-default for every non-allowlisted
(method, path).

## Comments

## Answer

Fixed in `plugin/authz/authz.ts`. `computeAuthz` is now deny-by-default and
method-aware, replacing the "non-thread ⇒ always allow" branch:

- Non-thread bootstrap paths (`/system/config`, `/sidebar-bootstrap`,
  `/plugins`, `/hosts`, `/plugin-settings/*`): GET allowed (the worker shapes
  them); any mutating method denied. So a read guest POSTing to another
  plugin's RPC (e.g. `/api/v1/plugins/automations/rpc/create`) is now denied.
- Thread paths: the ONLY guest mutation is `POST /threads/{t}/send` with write.
  `classifyPath` now returns the subpath after the thread id (`rest`), and the
  decision allows a mutating method only when `method === POST && rest ===
  "/send"`. So a write guest DELETE/PATCH/abort on a thread is denied.

Enforcement: the worker consults `/authz` per request and denies any
`allowed:false` before dispatch (`worker/src/stages/authz.ts:195`), so this
authoritative decision closes the hole end to end. No separate worker mutation
gate was added; the deny-by-default decision plus the worker's existing
`GUEST_DENIED_RPC_RE` cover it. A worker-side mutation gate as extra
defense-in-depth (so a future authz regression cannot reopen this) is left as
optional hardening, not required for correctness.

Tests: `plugin/authz/authz.test.ts` updated — the assertions that encoded the
old "non-thread always allowed" behavior are replaced, and a
`deny-by-default (issues 23, 24)` block adds read-guest-RPC-POST, thread
DELETE, non-send POST, and the project cases. Full suite 81/81 green, tsc
clean, plugin rebuilt and reinstalled.
