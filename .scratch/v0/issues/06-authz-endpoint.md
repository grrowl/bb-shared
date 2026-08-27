Status: resolved
Type: task
Blocked by: 04, 05

Plugin-hosted HTTP endpoint the worker pulls on every guest request.

`GET /api/v1/plugins/bb-shared/http/authz?token=…&path=…&method=…`

Response:

```
{
  allowed: boolean,
  thread_scope: string[],
  perms: { thread_id, mode }[],
  reason?: string
}
```

- Uses `PluginHttp.route` with `auth: 'token'` (bb's built-in per-plugin
  token, retrieved via `bb plugin token bb-shared` equivalent — see
  issue 07 for provisioning).
- Consumes token store from issue 05.
- Path check: does path reference a thread not in scope? Deny.
- Mutation check: if method is mutating, require `write` perm on the
  referenced thread.
- **This endpoint is authoritative** for authz decisions. The worker's
  mutation gate (10) delegates to this response rather than duplicating
  logic — 10's job is only path matching and enforcing whatever we
  return here.
- Non-thread paths (`/system/config`, `/sidebar-bootstrap`, `/plugins`,
  `/hosts`) are always allowed here; per-scope shaping happens in the
  worker's response filters (09).

## Comments

## Answer

Authoritative authz endpoint delivered.

**Files**

- `plugin/authz/authz.ts` — new. Pure decision logic + store-backed entry
  point + route registration.
- `plugin/server.ts` — imports and calls `registerAuthzRoute(bb, store)` right
  after the store is constructed. (Only server.ts and new `authz/` files were
  touched — `app.tsx` left alone for issue 16.)
- `plugin/authz/authz.test.ts` — new. 12 vitest cases.
- `plugin/tsconfig.json` — added `"authz"` to `include`.

**Endpoint**

`registerAuthzRoute` registers `GET authz` via `bb.http.route` with
`auth: "token"`, mounted by the host at
`/api/v1/plugins/bb-shared/http/authz`. Query params: `token` (raw bearer),
`path`, `method`. Response:
`{ allowed, thread_scope: string[], perms: {thread_id, mode}[], reason? }`.

**Logic** (`computeAuthz` is pure over `Token | null`; `authorize` does the
store lookup first):

- Raw bearer is resolved via the store's `findByRawToken`, which HMACs it with
  the per-process key and constant-time compares — no hashing logic duplicated
  here.
- Missing token → `allowed: false, reason: "missing token"`. Unknown/revoked
  token (`findByRawToken` → null) → `allowed: false, reason: "unknown token"`.
- Path is normalized (query/hash stripped, optional `/api/v1` prefix removed)
  then classified:
  - Non-thread (`/system/config`, `/sidebar-bootstrap`, `/plugins`, `/hosts`,
    `/plugin-settings/*`, `/projects/*`) → `allowed: true`. Per-scope shaping
    is the worker's response-filter job (issue 09); we still return the token's
    full `thread_scope` + `perms` so the worker can filter.
  - Thread (`/threads/{t}[/...]`) → allow iff `t` in scope; mutating method
    (POST/PUT/PATCH/DELETE) additionally requires `perm == write` on that
    thread.
  - Anything else → `allowed: false, reason: "unrecognized path: …"` (deny by
    default).
- Every response carries the token's `thread_scope` + `perms` (except the
  no-token / unknown-token cases, where they're empty), so the worker's
  mutation gate (issue 10) enforces purely from this response.

`/projects/*` was added to the non-thread pass-through list beyond the ticket's
explicit enumeration because SPEC's response-filter table lists
`GET /api/v1/projects/{p}` as a guest-visible endpoint; omitting it would 403
project loads. Worker still does the finer "share references p" filter.

**Verified**

- `npx tsc --noEmit` — clean.
- `bb plugin build .` — exit 0 (dist/server.js et al. emitted).
- `npx vitest run` — 44/44 pass (12 new: valid read, valid write,
  out-of-scope thread, missing token, unknown token, non-thread pass-through,
  mutating-without-write, plus `classifyPath` / `isMutatingMethod` /
  `computeAuthz` units).
