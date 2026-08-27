Status:
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
