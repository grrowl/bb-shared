Status:
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
