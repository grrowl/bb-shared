# 36 — Worker shim: hide the composer for a read-only guest

Part of the 2026-08-30 UX re-grill (see `.scratch/v0/ux-refinement.md` top
section and "Surface 6"). Build step 5. Worker-side. SECURITY-SENSITIVE and
guest-facing — this will get a careful review pass.

## Goal

A read-only guest currently sees a normal message composer; sending errors with
a "scope" toast (the server-side mutation gate correctly denies the send). Hide
the composer for a read grant so the guest sees a clean transcript with no
dead-end box. This is UX only — the mutation gate (issue 23) remains the real
security boundary and MUST NOT be weakened or relied upon less.

## The hard part (read this first — hand-compute it)

Perm is per (token, thread). A single guest can hold read on thread A and write
on thread B under one Link. The SPA navigates between threads CLIENT-SIDE without
re-fetching the HTML shell, so a static CSS rule injected at document load cannot
know which thread is currently viewed. Before writing code, hand-compute the
flow (use the `hand-compute` skill): worker serves shell → guest views thread A
(read) → client-routes to thread B (write) → composer must reappear. Write the
state at each transition and confirm your design handles route changes, not just
first paint.

## Current state

- `worker/src/stages/chrome-shim.ts` injects a permission-BLIND block into
  `<head>`: a script sets `document.documentElement.dataset.bbGuest = "1"` and a
  `<style>` (built from `worker/src/chrome-selectors.ts`) hides owner chrome via
  `[data-bb-guest] <selector> { display:none }`.
- `worker/src/scope.ts` `GuestScope` = `{ threadIds, projectIds }` — per-thread
  PERMS are dropped. The authz stage (`worker/src/stages/authz.ts`) DOES receive
  `perms: AuthzPerm[]` (per-thread mode) from the plugin `/authz` response but
  discards them when building the scope. `ctx.scope` is on `RequestContext`
  (pipeline.ts:45).
- `worker/scripts/check-chrome-selectors.mjs` pins each selector's `probe`
  against a built bb SPA in CI — any new selector you add MUST have a probe and
  pass this check.

## Design constraints / required approach

- Carry the guest's per-thread perms to the client. Extend the authz→scope path
  so the worker has `threadId → "read"|"write"` available at shim-injection time
  (e.g. add a `perms` map to `GuestScope` or carry it alongside on ctx). Keep
  `EMPTY_SCOPE` safe.
- Inject the perm map (thread → perm) into the guest document AND a tiny script
  that, on every client-side route change (history pushState/replaceState +
  popstate), reads the current thread id from the URL and sets a root attribute
  reflecting the CURRENT thread's perm (e.g. `data-bb-guest-perm="read"`). A CSS
  rule hides the composer only when that attribute is `read`.
- Add the composer selector to `chrome-selectors.ts` (with a `probe` and note),
  so the CI selector-pin covers it. Find the real bb composer selector/testid in
  the bb checkout referenced by that file; do not guess.
- Safe defaults: if the current thread's perm is unknown/unresolved, DO NOT hide
  the composer (a write guest must never be blocked from the UI; worst case is
  today's behavior — a read guest briefly sees a box that server-denies). The
  mutation gate is unaffected either way.
- Do not leak anything beyond the guest's own perms into the document. The perm
  map must contain only the threads this token covers (it already is scoped).
- Injection must keep working under both HTMLRewriter (edge) and the string
  fallback (tests), matching the existing dual-path contract.

## Acceptance

- Read-only single-thread guest: composer hidden on load.
- Mixed-perm guest: composer hidden on a read thread, visible on a write thread,
  updating across client-side navigation (proven by the hand-computed trace and
  a unit test of the injected script's logic where feasible).
- New composer selector is pinned in `check-chrome-selectors.mjs` and passes.
- Worker test suite green; `tsc` clean. Existing shim tests updated.

## Notes for the implementor

- You inherit no prior context. Read `.scratch/v0/ux-refinement.md` (Surface 6),
  chrome-shim.ts, chrome-selectors.ts, scope.ts, and stages/authz.ts before
  editing. Match the existing style and the dual-path injection contract.
- This is security-sensitive: keep changes minimal and auditable, never weaken
  the mutation gate, and report your final approach + the hand-computed trace so
  the reviewer can check the route-change handling.
