# 33 — Shared 3-state [off | read | write] perm segment component

Part of the 2026-08-30 UX re-grill (see `.scratch/v0/ux-refinement.md` top
section). Build step 2. A small reusable frontend component with no backend
dependency — can land in parallel with issue 32. Owner-side only.

## Goal

One control used in both the share popover (issue 34) and the tokens panel
(issue 35): a three-state segmented control expressing a thread's grant on a
Link. States: **off** (thread not on this Link), **read**, **write**. Clicking a
state applies it. This single control replaces, across both surfaces: the two
add-buttons that disable when covered, the separate Upgrade/Downgrade button,
the remove trash icon, and the standalone perm chip.

## Semantics

- Value type: `"off" | "read" | "write"` (import `Perm` = `"read" | "write"`
  from `../server` type-only; the component's value is `Perm | "off"`).
- Controlled component: `value` + `onChange(next)`. The parent maps changes to
  RPC calls (issue 34/35 wire it): off→remove/no-op, read/write→add or
  updateShare. The component itself makes NO rpc calls.
- A `busy`/`disabled` prop to lock the control while an RPC is in flight, and a
  small pending affordance. Per-state busy is not needed — one busy for the whole
  segment is fine (a change is one RPC).
- Accessible: `role="radiogroup"` with three `role="radio"` cells (mirror the
  existing new-link radiogroup in share-popover.tsx:264-286 for markup/idiom and
  Tailwind classes). Clear `aria-label`s ("Not shared", "Read", "Write").
- Compact sizing to fit both a popover row and a panel row (h-7-ish, text-xs),
  matching existing controls.

## Where it lives

- New file `plugin/components/ui/perm-segment.tsx` (co-locate with the other
  vendored UI primitives under `plugin/components/ui/`). Export a named
  `PermSegment`.
- Reuse `cn` from `../../lib/utils` and the visual language already used by the
  new-link radiogroup (selected = `bg-foreground text-background`, unselected =
  muted with hover). Give "off" a visually-neutral/least-emphasis treatment so
  the resting state reads as "not shared".

## Acceptance

- Renders three cells; the current `value` cell is visibly selected.
- `onChange` fires with the clicked state; clicking the already-selected state is
  a no-op (or fires — decide, but be consistent and documented in a comment).
- `disabled`/`busy` prevents interaction and dims.
- A vitest component test (follow the repo's existing frontend test setup —
  check for an existing `*.test.tsx` under plugin/ to match harness/imports):
  renders each value, asserts selected cell, asserts onChange payloads, asserts
  disabled blocks onChange.
- `tsc` clean; test suite green. No backend or contract changes in this issue.

## Notes for the implementor

- You inherit no prior context. Read `.scratch/v0/ux-refinement.md` (top
  section) "One control everywhere" for intent. Do NOT wire it into the popover
  or panel — that's issues 34/35; this issue delivers only the component + test.
- Match the surrounding code style and the existing radiogroup idiom exactly.
