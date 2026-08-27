# bb realtime WebSocket event catalog

For the WS frame filter in the bb-shared worker (issue 11). The filter's
job is to keep a guest from seeing anything about threads their token
does not cover — thread contents, thread existence, project topology,
host/infra state, plugin traffic.

Two transports carry realtime traffic to browsers:

- `GET /ws` — the main app socket. Multiplexed via subscribe/unsubscribe
  frames; also carries three broadcast-to-everyone signal types the
  server sends unconditionally (no subscription required).
- `GET /ws/terminals/:terminalId` — per-terminal binary/text stream.
  Guests must not be able to open this socket at all in v0.

Sources: `packages/domain/src/change-kinds.ts`, `packages/sdk/src/realtime-types.ts`,
`packages/server-contract/src/api/shared.ts`, `packages/server-contract/src/api/threads.ts`,
`packages/server-contract/src/api/terminals.ts`, `apps/server/src/ws/hub.ts`,
`apps/server/src/ws/client-protocol.ts`, `apps/server/src/server.ts:704-770`.

`S` below denotes the token's scope: `S.thread_scope` (set of thread ids),
`S.project_scope` (set of projects referenced by any share — worker
computes from `perms`).

## Server → guest frames on `/ws`

### Subscribed entity-change broadcasts (`type: "changed"`)

The server side only pushes to sockets subscribed to the relevant key
(`thread-list`, `thread-detail:<id>`, `project-list`, `project-detail:<id>`,
etc — see `apps/server/src/ws/hub.ts:102`). Even with the guest→local
allowlist below in place, the worker MUST re-check on every inbound frame
in case the server ever gains a broadcast-to-all code path for these
types — defence in depth.

| Event | Payload sketch | Scope field(s) | Filter predicate for token scope S | Notes |
|---|---|---|---|---|
| `changed` / `thread` | `{ type: "changed", entity: "thread", id?: string, metadata?: { backgroundActivityChanged?, eventTypes?: ThreadEventType[], hasPendingInteraction?, projectId?, statusChange?: {status,runtime,activity,latestAttentionAt,updatedAt} }, changes: ThreadChangeKind[] }` — kinds: `thread-created`, `thread-deleted`, `events-appended`, `history-rewritten`, `interactions-changed`, `status-changed`, `title-changed`, `queue-changed`, `archived-changed`, `pin-state-changed`, `parent-changed`, `environment-changed`, `read-state-changed`, `order-changed`, `tabs-changed`, `terminals-changed` | `msg.id` = thread_id; secondary `msg.metadata.projectId` | Pass iff `msg.id !== undefined && msg.id ∈ S.thread_scope`. Drop when `id` is absent (would be a list-wide refresh — worker never subscribes guest to `thread-list`, but drop as belt-and-braces). Also strip `metadata.projectId` if it is not in `S.project_scope` (rare — should already be, since the thread is scoped). | Primary transcript-update channel; `events-appended` is the streaming turn signal — dropping it for a shared thread breaks live viewing. `thread-created` on a NEW id (owner just made a thread) has `msg.id ∉ S.thread_scope` and gets dropped by the same rule — that is correct, guest scope only grows via explicit token mutation. |
| `changed` / `project` | `{ type: "changed", entity: "project", id?: string, changes: ProjectChangeKind[] }` — kinds: `project-created`, `project-updated`, `project-deleted`, `project-sources-changed`, `threads-changed`, `project-order-changed` | `msg.id` = project_id | Pass iff `msg.id !== undefined && msg.id ∈ S.project_scope`. Drop when `id` is absent. | `threads-changed` fires on the project's thread list mutating (add/remove/reorder). The guest's sidebar bootstrap is already scope-filtered on refetch, and the SPA reacts to this by refetching the project — which the worker re-filters at the HTTP layer. So passing it through for in-scope projects is safe. |
| `changed` / `environment` | `{ type: "changed", entity: "environment", id?: string, changes: EnvironmentChangeKind[] }` — kinds: `environment-created`, `environment-deleted`, `metadata-changed`, `status-changed`, `work-status-changed`, `git-refs-changed`, `thread-storage-changed` | `msg.id` = environment_id | **Drop by default in v0.** Environments have no direct scope field in the token. Passing all through leaks the owner's workspace inventory (worktree churn, git branch activity on unrelated projects). | v1 upgrade: extend `/api/v1/bb-shared/authz` to include `environment_scope` (union of environments referenced by threads in scope) and pass iff `id ∈ env_scope`. Guest impact of dropping in v0: workspace status pill in a shared thread's header may show stale data until the SPA refetches the thread; acceptable. |
| `changed` / `host` | `{ type: "changed", entity: "host", id?: string, changes: HostChangeKind[] }` — kinds: `host-connected`, `host-disconnected` | `msg.id` = host_id | **Drop unconditionally.** | Host state is owner infrastructure; guests must never see host ids or the fact that the owner just paired/lost a machine. `/api/v1/hosts` already returns `[]` for guests (SPEC filter table). |
| `changed` / `system` | `{ type: "changed", entity: "system", changes: SystemChangeKind[] }` — kinds: `config-changed`, `plugins-changed`, `provider-registrations-changed` | none (unscoped) | **Drop unconditionally.** | `config-changed` triggers a `/api/v1/system/config` refetch — worker's HTTP filter reshapes that response, but the invalidation itself signals the owner is fiddling with settings. `plugins-changed`/`provider-registrations-changed` are pure owner-side activity; also, the guest's `/api/v1/plugins` inventory is empty so refreshing it does nothing useful. Both `system:changed` and `system:config-changed` listener types (SDK dispatches the config-changed subset separately) resolve to the same wire message; dropping it covers both. |

### Ephemeral broadcasts (no subscription required, sent to every open client)

These are the highest-risk frames — the server iterates
`clientKeysBySocket` and sends to every socket regardless of subscribe
state (`apps/server/src/ws/hub.ts:790-861`). Nothing keeps them from
reaching a guest without the filter.

| Event | Payload sketch | Scope field(s) | Filter predicate for token scope S | Notes |
|---|---|---|---|---|
| `thread-open` | `{ type: "thread-open", projectId, threadId, split: ThreadOpenSplit, file: ThreadOpenFile \| null }` | `msg.threadId`, `msg.projectId` | Pass iff `msg.threadId ∈ S.thread_scope` AND `msg.projectId ∈ S.project_scope`. Drop otherwise. Conservative option for v0: **drop unconditionally** (no obvious guest UX need — guest doesn't drive the owner's window layout). | Fires when anyone calls `POST /threads/:id/open` — owner clicking a thread in the sidebar, plugin scripting, etc. Without the filter the guest learns every thread id the owner opens, plus opened file paths — a serious topology leak. |
| `thread-pane-action` | `{ type: "thread-pane-action", projectId, threadId, action: "maximize"\|"restore"\|"toggle"\|"spotlight"\|"clear-spotlight" }` | `msg.threadId`, `msg.projectId` | Pass iff `msg.threadId ∈ S.thread_scope`. Recommended v0: **drop unconditionally.** | Same shape as thread-open, same leak surface, and even less guest utility. |
| `plugin-signal` | `{ type: "plugin-signal", pluginId: string, channel: string, payload: unknown }` | `msg.pluginId` (there is NO thread/project scope field) | **Drop unconditionally in v0.** | Emitted by any plugin calling `bb.realtime.publish(channel, payload)`. `payload` is arbitrary plugin-defined data — could easily contain thread ids, file contents, secrets. Since v0 disables plugin frontends for guests (`/api/v1/plugins` returns `[]`), the guest SPA has no handler that would even react. When plugin-frontends-for-guests lands (SPEC open question 1), revisit with a per-allowed-plugin allowlist plus per-plugin scope reasoning; the wire shape itself carries no scope hint. |
| `pong` | `{ type: "pong" }` | none | Pass through. | Reply to the client's `ping` liveness probe. No payload, no leak. |

### Not currently sent to `/ws`

The SDK's `realtime-client.ts:558-566` explicitly documents that it
"silently skips message types this client does not consume", so any
future `type` other than `changed`, `thread-open`, `thread-pane-action`,
`plugin-signal`, `pong` is possible. The worker's WS filter should have
a **default-drop** posture on unrecognised `type` values, matching the
same conservative bias.

## Guest → local frames on `/ws`

Client message schema (`packages/domain/src/change-kinds.ts:128-156`) is
tight: `subscribe`, `unsubscribe`, `ping`. Nothing else parses; the
server closes the socket with `1008 invalid-message` on unknown shapes
(`apps/server/src/ws/client-protocol.ts:39-42`).

The worker enforces its own allowlist first (defence in depth against
future protocol additions):

| Client frame | Worker action for scope S |
|---|---|
| `{ type: "subscribe", target: { kind: "thread-detail", threadId } }` | Forward iff `threadId ∈ S.thread_scope`. Otherwise drop the frame silently and log at debug. |
| `{ type: "unsubscribe", target: { kind: "thread-detail", threadId } }` | Forward iff `threadId ∈ S.thread_scope`. (Idempotent server-side; still gated to avoid teaching the guest anything.) |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "project-detail", projectId } }` | Forward iff `projectId ∈ S.project_scope`. Reasoning: the SPA subscribes to a project when the guest opens a scoped thread in that project. |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "thread-list" } }` | **Drop.** Would subscribe the guest to broadcasts about threads outside scope. The SPA's sidebar-bootstrap is already scope-filtered; the guest doesn't need thread-list updates in v0 (any new share triggers a full bootstrap refetch driven by the plugin's token mutation, not this channel). |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "project-list" } }` | **Drop.** Same reasoning — guest project topology is set at bootstrap time. |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "environment-detail" \| "environment-list" } }` | **Drop.** No v0 need; environment events dropped inbound anyway. |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "host-detail" \| "host-list" } }` | **Drop.** Guest never sees hosts. |
| `{ type: "subscribe" \| "unsubscribe", target: { kind: "system" } }` | **Drop.** Guest never sees system-level changes. |
| `{ type: "ping" }` | Forward. Liveness probe, no state. |
| anything else | Drop and close socket with `1008 invalid-message`, matching server behaviour. |

Silent drop (rather than closing the socket) on scoped-target denials is
preferred so a legitimate guest whose scope was just reduced (owner
removed a share mid-session) sees at most a stale UI, not a disconnect
loop. The bootstrap refetch on the next HTTP round-trip corrects the UI.

## `/ws/terminals/:terminalId`

Terminal WS surface (`apps/server/src/server.ts:725-770`,
`packages/server-contract/src/api/terminals.ts:213-253`).

- **Recommendation for v0: worker refuses the upgrade entirely for guest
  requests, returning `403`.** No guest UX in v0 needs terminal
  streaming; the shared thread transcript is enough.
- If terminal streaming is later needed for a guest, gating requires
  resolving `terminalId` → owning `threadId` via a plugin authz call
  (there is no thread id in the URL path — it is a bare terminal id).
  Server frames if allowed: `attached`, `output` (potentially very
  large — 32 MiB queue watermark), `session-updated`, `exited`, `error`,
  `pong`. All of them carry either the terminal session record (which
  includes thread id and command) or raw pty output — full disclosure
  of whatever the owner is running. Any relaxation of the v0 policy
  needs its own spike.

## Summary table (top-line)

- 5 subscribed `changed` variants (thread, project, environment, host, system)
- 3 ephemeral broadcast types (`thread-open`, `thread-pane-action`, `plugin-signal`)
- 1 protocol reply (`pong`)
- 9 client-side subscription targets (4 detail + 4 list + `system`), plus `ping`
- 1 separate WS URL (`/ws/terminals/:id`) — deny outright in v0

Pass-through allowlist for guests:
- `changed` / `thread` when `id ∈ S.thread_scope`
- `changed` / `project` when `id ∈ S.project_scope`
- `pong`
- Optionally `thread-open` / `thread-pane-action` when both ids are in
  scope; safer default is to drop.

Everything else: drop.
