Status: resolved
Type: research

Catalog every event shape emitted over bb's `/ws` (defined in
`packages/sdk/src/realtime-types.ts` in the bb repo) that could leak
information to a guest.

Answer:

- Full list of event types (name, payload shape).
- For each: which field(s) identify the scoped entity — `thread_id`,
  `project_id`, `host_id`, `plugin_id`?
- Recommended filter predicate per event type for the worker WS
  frame filter (issue 11).
- Events with no clear scope — recommend "drop by default" and note why.

Deliverable: `research/realtime-events.md` — a table indexable by
event type with the predicate the worker should apply.

## Comments

## Answer

Full catalog in [`research/realtime-events.md`](../../../research/realtime-events.md).

Two guest-relevant WS surfaces:

- `/ws` — 5 subscribed `changed` entity types (thread, project,
  environment, host, system), 3 ephemeral broadcasts sent to every
  connected client with no subscription (`thread-open`,
  `thread-pane-action`, `plugin-signal`), plus `pong`.
- `/ws/terminals/:terminalId` — deny outright for guests in v0.

Filter shape for the worker (issue 11):

- Pass `changed`/thread iff `msg.id ∈ S.thread_scope`.
- Pass `changed`/project iff `msg.id ∈ S.project_scope` (project set
  derived from token shares).
- **Drop by default** — `changed`/environment (no scope field in the
  token; v1 could extend authz with `env_scope`), `changed`/host,
  `changed`/system, `thread-open`, `thread-pane-action`,
  `plugin-signal`, and anything with an unrecognised `type`.
- Pass `pong`.
- Guest → local subscribes: allowlist to `thread-detail` /
  `project-detail` in scope plus `ping`; drop `thread-list`,
  `project-list`, `environment-*`, `host-*`, `system` subscribes so the
  server never adds the guest to those broadcast lists.

Notable finding: three ephemeral broadcast types are sent to every
socket regardless of subscription state (`hub.ts:790-861`) — without
the WS filter a guest sees every `thread-open` (thread id + file path)
and every `plugin-signal` (arbitrary plugin-defined payload) on the
box. Drop-by-default on those is load-bearing.
