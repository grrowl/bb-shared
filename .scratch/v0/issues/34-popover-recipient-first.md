# 34 — Share popover: recipient-first, segment rows, auto-name + instant copy

Part of the 2026-08-30 UX re-grill (see `.scratch/v0/ux-refinement.md` top
section, "Surface 3"). Build step 3. Owner-side frontend only.

DEPENDS ON: issue 32 (listTokens `url` + share `title`) and issue 33
(`PermSegment` component). Do not start until both are merged/available on the
branch you build from. If they are not yet present, stop and report.

## Goal

Rework `plugin/share-popover/share-popover.tsx` from "add this thread to a bag"
into "grant this thread to a Link (a named recipient)".

## Target design

- Title stays "Share this thread".
- **List of Links (recipients).** Each row: the Link's label (name) + a
  `PermSegment` (issue 33) reflecting THIS thread's grant on that Link:
  - value = the perm of this thread's share on the Link, or `"off"` if not shared.
  - onChange: `off`→`removeShare`, `read`/`write`→ if not yet shared `addShare`,
    else `updateShare`. (Reuse the existing rpc methods; see server.ts contract.)
  - Also show the Link's **derived perm summary** as a small read-only badge:
    highest perm across all its threads (write if any share is write, else read).
    This is display-only — NOT editable. Keep it visually distinct from the
    per-thread segment so they aren't confused.
- **New link** action: auto-names via the existing verb-noun generator (server
  already does this when `label` is omitted from `mintToken` — keep passing the
  current-thread `firstThread` with the selected perm), grants the current
  thread, and copies the returned URL instantly (keep the existing clipboard +
  flash logic in `handleMint`, share-popover.tsx:149). Keep the small read|write
  choice on the New-link action (the radiogroup at 264-286). Button label stays
  contextual: "Create link" when no links exist, else "Create new link".
- **Remove** the current "Add to a link" two-button-with-disable UI
  (share-popover.tsx:198-256) and the `isPermCovered`/`BusyKey` add-button
  machinery — the segment replaces it.
- Keep "Manage all links" footer → `navigate.toPluginPanel("tokens")`.
- Copy stays in the owner's plain style (short, plain words; see
  `~/.claude/skills/plain-writing`). Flash strings: "Link copied.",
  "Shared as read"/"Shared as write" on a segment change, and the existing error
  strings. Keep them terse.

## Constraints

- No backend/contract changes here (they land in 32). Consume the new
  `token.url` and `share.title` fields; but the popover keys off THIS thread's
  share, so title is less relevant here than in the panel — fine to ignore title
  in the popover.
- Preserve the realtime refetch (`useRealtime(REALTIME_CHANNELS.tokensChanged)`)
  and the last-write-wins load guard (share-popover.tsx:78-99).
- Preserve the command-palette open path and the header-action wiring at the
  bottom of the file unchanged.

## Acceptance

- With no links: shows the New-link create action; creating auto-names, grants
  this thread, copies the URL.
- With links: each Link row shows the segment at this thread's current perm;
  toggling read↔write updates it; off removes; a fresh read/write on an
  unshared Link adds it. The Link's derived summary badge updates accordingly.
- No mysteriously-disabled buttons remain.
- `tsc` clean; frontend tests updated (the popover has existing tests — update
  them to the new structure) and green. Reinstall/reload not required in-agent;
  just leave the build green.

## Notes for the implementor

- You inherit no prior context. Read `.scratch/v0/ux-refinement.md` (top
  section) fully, then read the CURRENT share-popover.tsx and issue 33's
  component before editing. Match existing style/idioms.
- Report back: the final row layout, and any contract field you found missing
  from issue 32 (so we can fix 32 rather than hack around it).
