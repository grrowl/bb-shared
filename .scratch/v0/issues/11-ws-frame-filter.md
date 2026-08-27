Status: resolved
Type: task
Blocked by: 03, 08

Bidirectional WebSocket frame filter at the worker.

- Guest → local bb: allowlist only scoped subscribes (thread ids in
  scope). Drop everything else.
- Local bb → guest: drop `changed`/`entity` invalidations whose target
  isn't in scope. Without this, guests observe invalidations for
  threads they can't view.
- Consume the catalog from issue 03.
- Preserve upstream close/ping/pong semantics.
- Tests with synthetic frame streams — a fixture of realistic frames
  from a running bb instance.

**Share fixture capture with issue 09**: one snapshot of a live bb
instance's responses + WS frames serves both. Coordinate on fixture
location.

## Comments

## Answer

Bidirectional WS frame filter landed as a new pipeline stage. No existing
stage edited; `worker.ts` (wiring) and `pipeline.ts` (context type) extended
per the documented extension model.

### Files

- **`worker/src/stages/ws-frame-filter.ts`** — the stage + the pure per-frame
  decision functions + the live socket bridge:
  - `filterClientFrame(raw, scope)` — guest → local bb allowlist.
  - `filterServerFrame(raw, scope)` — local bb → guest filter.
  - `wsFrameFilterStage(router)` — pipeline stage; owns all WS upgrades.
  - `bridgeGuestWebSocket(serverSocket, scope)` — interposes the filter on a
    live `/ws` connection via a `WebSocketPair` (Workers runtime only).
- **`worker/src/scope.ts`** — `GuestScope` (`threadIds`, `projectIds`) +
  `EMPTY_SCOPE`. Standalone to avoid a pipeline↔stage import cycle.
- **`worker/src/pipeline.ts`** — `RequestContext.scope: GuestScope | null`,
  populated upstream by the authz stage (10); null ⇒ deny-everything.
- **`worker/src/worker.ts`** — `wsFrameFilterStage(router)` inserted before
  `dispatchStage`; `scope: null` in the initial context.
- **`worker/tests/ws-frame-filter.test.ts`** — 43 tests over synthetic frame
  streams.

### Behaviour (wire shapes verified against the bb repo)

Guest → local bb (`filterClientFrame`):
- `ping` → forward. `subscribe`/`unsubscribe` `thread-detail` → forward iff
  `threadId ∈ threadIds`; `project-detail` → forward iff `projectId ∈
  projectIds`; else silent drop.
- `thread-list`, `project-list`, `environment-detail/-list`,
  `host-detail/-list`, `system` targets → silent drop (stale UI beats a
  disconnect loop when a share is revoked mid-session).
- Malformed / unknown `type` / target-less subscribe → close `1008
  invalid-message`, matching `apps/server/src/ws/client-protocol.ts`.

Local bb → guest (`filterServerFrame`, default-drop posture):
- `pong` → forward. `changed`/`thread` → forward iff `id` present and in
  scope (stray out-of-scope `metadata.projectId` stripped); `changed`/`project`
  → forward iff `id` present and in scope.
- `changed`/`environment`, `changed`/`host`, `changed`/`system`,
  `thread-open`, `thread-pane-action`, `plugin-signal`, id-less `changed`,
  and any unrecognised `type` → drop.

`/ws/terminals/:id`: upgrade rejected `403 { error: "scope" }` for guests.

Close/ping/pong semantics preserved: app-level `pong` relayed as a normal
frame; WS-protocol close/error propagate both directions through the bridge.

Scope source is `ctx.scope` (the authz stage from 10 populates it from the
token's shares); until then a null scope resolves to `EMPTY_SCOPE`
(deny-everything), so the filter is safe-by-default the moment it is wired.

### Verify

- `tsc --noEmit` — clean.
- `vitest run` — 92 passed (43 new): in-scope pass, out-of-scope drop,
  ephemeral drop, subscribe allowlist, terminal reject, stage routing.
- `wrangler deploy --dry-run` — builds (16.47 KiB).
