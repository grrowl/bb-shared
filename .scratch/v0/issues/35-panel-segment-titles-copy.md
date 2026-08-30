# 35 — Tokens panel: segment rows, thread titles, copy-always, derived badge

Part of the 2026-08-30 UX re-grill (see `.scratch/v0/ux-refinement.md` top
section, "Surface 5"). Build step 4. Owner-side frontend only.

DEPENDS ON: issue 32 (listTokens `url` + share `title`) and issue 33
(`PermSegment`). Do not start until both are available. If absent, stop and
report.

## Goal

Rework `plugin/nav-panel/tokens-panel.tsx` (the "Shared threads" nav panel) to
match the recipient model.

## Target design

1. **Share rows use `PermSegment`.** Replace the current `ShareRow` internals
   (tokens-panel.tsx:618-671: `PermChip` + Upgrade/Downgrade button + remove
   trash icon) with a single `PermSegment` bound to that thread's perm:
   - read↔write → `updateShare`; off → `removeShare`. (`addShare` isn't reachable
     from a row that already exists; off = remove.)
   - Delete the `PermChip`, the Upgrade/Downgrade `Button`, and the remove icon
     button.
2. **Thread titles, not ids.** Render `share.title ?? share.thread_id` (title
   from issue 32) as the row's primary label. Keep the "open thread" click
   (`navigate.toThread(share.thread_id)`). Keep the id available as a `title`
   tooltip / secondary if convenient.
3. **Copy URL always works.** Use `token.url` from listTokens (issue 32) instead
   of the frontend `mintedUrls` map. Remove `mintedUrls` state
   (tokens-panel.tsx:831) and the `mintedUrl` prop threading; remove the
   disabled state and the "shown once" tooltip (tokens-panel.tsx:737-746). Copy
   is enabled for every listed link.
4. **Link-level: derived perm summary badge only.** On each token card header
   (near the renameable label, tokens-panel.tsx:732), show a small read-only
   badge = highest perm across the token's shares (write if any share is write,
   else read; nothing if no shares). There is NO editable link-level perm
   control — confirm none exists and none is added.
5. Keep: rename (`RenameableLabel`), delete-token behind the AlertDialog confirm
   (keep the existing copy: "Delete this link?" etc.), the worker-status pill and
   claim nudge (NOT in scope this issue — leave as-is), realtime refetch, the
   "Mint new" header button.

## Constraints

- No backend/contract changes here (they land in 32). Consume `token.url` and
  `share.title`.
- Copy stays in the owner's plain style (`~/.claude/skills/plain-writing`).
- Do not touch Surface 2 (pill/claim) behavior in this issue.

## Acceptance

- Rows show titles; each row's segment reflects and edits the perm; off removes.
- Copy URL enabled for every link and copies the correct guest URL.
- Card header shows the derived summary badge; no editable link-wide perm.
- No `mintedUrls`/`mintedUrl` remnants; no "shown once" tooltip; no PermChip or
  Upgrade/Downgrade/remove-icon remnants in `ShareRow`.
- `tsc` clean; the panel's existing tests updated to the new structure and green.

## Notes for the implementor

- You inherit no prior context. Read `.scratch/v0/ux-refinement.md` (top
  section), then the CURRENT tokens-panel.tsx and issue 33's component before
  editing. Match existing style/idioms and comment density.
- Report back: what you removed, and any issue-32 field that was missing.
