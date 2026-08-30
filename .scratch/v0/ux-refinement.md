# bb-shared UX refinement

## Re-grill 2026-08-30 — the Link-is-a-recipient model (supersedes parts below)

Now that the guest flow works end to end, the owner re-opened the model itself.
The four complaints (multiple named links with no visible purpose, buttons that
disable for no stated reason, awkward link management, a superfluous per-link
upgrade/downgrade) all trace to one decision the 2026-08-28 pass kept: a link is
a bag of thread-shares. The re-grill replaces the mental model. Copy stays in
the owner's plain style.

### The model (locked)

- A **Link is a named recipient** you grant threads to. The name is who it is
  for, like "Head of Product". You still call the object a "Link" in the UI, but
  the flow reads as "grant this thread to a Link".
- A Link holds many thread grants. **Perm is stored per (link, thread) only.
  There is no per-link perm in the data model and never has been** (the `perm`
  field lives on each `Share`, not the `Token`). Per-thread perm is what keeps
  the one-URL-per-person promise: a recipient can have most threads read and one
  write under a single Link, instead of being forced into a second URL.
- **A Link shows a derived perm summary, read-only** — the highest perm across
  its threads (write if any thread is write, else read), as a small badge. There
  is no editable link-level perm control anywhere. This is the fix for the
  superfluous per-link toggle (complaint 4); what looked link-wide was really
  the per-thread Upgrade/Downgrade button on a single-thread link.
- Multi-thread is a real case (share a set of epic threads with one person) and
  single-thread is a real case (share one thread with a coworker). Both are just
  "a Link with N threads", so one URL per recipient is correct.
- **Ephemeral for now.** The whole set still resets on bb restart, and the owner
  re-shares in the morning. Durable per-person links (surviving restart, secret
  persisted to disk with the ticket-29 envelope) are deferred, not chosen.

### One control everywhere: a 3-state segment [off | read | write]

Both the popover row and the panel row use the same control for a thread on a
Link: a three-state segment. Off means the thread is not on that Link. Clicking
read or write grants at that perm; clicking off revokes. This single control
replaces, in one move: the two add buttons that mysteriously disabled
(complaint 2), the separate Upgrade and Downgrade button, the remove trash
icon, and the standalone perm chip. Grant, upgrade, downgrade, and revoke are
now the same gesture.

### Surface 3, the share popover (locked)

- Recipient-first. Title stays "Share this thread". Below it, a list of Links,
  each row showing the Link name and the 3-state segment for this thread.
- "New link" auto-names the Link with the existing verb-noun generator
  (`randomLabel`, e.g. "brave-otter"), grants the current thread, and copies the
  URL instantly. No name prompt. Rename lives in the panel.
- No more "already shared as X" disabled state to explain, because the segment
  simply shows the current perm.

### Surface 5, the panel (locked)

- The share row becomes the same 3-state segment. Drop the perm chip, the
  Upgrade/Downgrade button, and the remove icon.
- **Show thread titles, not raw ids.** listTokens resolves each shared thread's
  title (add the title to the RPC contract plus a bb thread-title lookup; fall
  back to the id if the thread is gone).
- **Copy URL always works.** The server holds the raw link in memory for the
  session, so every listed link can be copied until restart. Remove the disabled
  state and the "shown once" tooltip. This is the surface-4 copy-again work,
  now in scope because links are ephemeral anyway.

### Surface 6, the guest view (locked, now building)

- **Hide the composer for a read-only guest.** The shim carries the per-thread
  perm the worker already resolved at authz time, and hides the message box for
  a read grant so a read guest never types into a dead-end "scope" error. This
  was locked on 2026-08-28 and is now in this build pass.

### Implementation status (2026-08-30)

All five issues landed on main and the plugin was rebuilt + reloaded (running
clean). Each was built by an opus subthread, reviewed by sonnet, and the two
security-relevant ones (32 bearer distribution, 36 guest script injection) also
cleared a fable security pass. Tests: plugin 203 passed / 1 skipped, worker 197
passed; tsc clean both sides.

- 32 (server: listTokens per-token `url` + per-share `title`) — merged.
- 33 (`PermSegment` [off|read|write] control) — merged.
- 34 (recipient-first share popover) — merged.
- 35 (panel: segment rows, titles, copy-always, derived badge) — merged.
- 36 (worker: hide composer for read guests) — merged.

Open follow-up (not blocking): harden the worker's guest RPC-deny regex against
`%2F`-encoded paths (fable's residual on 32; the plugin-authz mutating-method
deny backstops it today). Visual/subjective UX review by the owner still pending.

### Build order

1. Server: hold raw links in memory for the session; add thread titles and the
   raw URL to listTokens (contract change). Underpins copy-always and titles.
2. Shared 3-state segment component; swap it into the popover and the panel.
3. Popover: recipient-first list, auto-named New link, instant copy.
4. Panel: titles, copy-always, segment rows, drop chip/upgrade/remove.
5. Worker shim: carry per-thread perm, hide the composer for read guests.

Everything below is the earlier 2026-08-28 pass, kept for the copy and the
worker/claim design. Where it conflicts with the model above, the model wins.

---

Decisions from the owner grilling session on 2026-08-28. Copy is written in the
owner's plain style (see ~/.claude/skills/plain-writing). We walked the owner
UX surface by surface. Each surface below lists what was locked.

## Vocabulary (applies everywhere the owner reads)

- Use "link" for the thing you send a guest, and "create" for making one.
- Keep "token" only inside the code and the wire, not in owner copy.
- Keep "read" and "write" as the two permission words. The owner chose the
  precise words over friendlier ones.

## Surface 1. The guest link

Locked:
- Mint deploys the worker first and only then builds and copies a real link. No
  `<worker-pending>` placeholder ever reaches the owner. If the deploy fails,
  mint fails with a clear message instead of copying a broken link. This turns
  the placeholder in `plugin/lib/token-store.ts:346` into real behavior and
  ties to issue 07 and ticket 27.
- The raw token stays in the URL path. Accepted risk: it sits in the guest's
  address bar and history for the whole session, so a screen share exposes it.
  The cheap future fix is a one-time handoff that swaps the token for a cookie
  and removes it from the visible URL. Not doing it now.
- The link opens the shared thread directly.

Copy:
- First mint, deploying: "Setting up your share worker. This happens once."
- Mint done: "New token minted. Link copied."  (reword to "Link created. Copied.")
- Copy link when no link is available: "The guest link is shown once, when you
  create it. Create again to get a fresh link."
- Copy link success: "Link copied."

## Surface 2. Worker status and claim nudge

Locked:
- Before any share exists the pill reads as a calm empty state. It only turns
  to an error color when a worker that should be running is down.
- The claim nudge appears only once a real worker exists. The "No claim link
  yet" placeholder line is removed.
- The pill needs the token count the panel already holds, to show the empty
  state. One prop, not a new call.

Pill states (dot color unchanged, wording changed, one new state):
- No shares yet: "No shares yet", neutral dot.
- Deploying on first mint: "Setting up worker…", neutral pulsing dot.
- Healthy: "Worker live", green dot.
- Reachable but unhealthy: "Worker having trouble", amber dot.
- Should be up but not answering: "Worker not responding", red dot.

Claim nudge (only when a worker exists and it is not yet confirmed claimed):
"This worker is temporary and is removed 60 minutes after it starts. Claim this
worker to keep your share links working."

Two more pill states follow from the claim design in issue 28. Confirmation is
invisible to the owner until about 60 minutes in, because the plugin can only
prove a claim by the worker surviving past its expiry. So:
- Confirmed claimed: "Worker claimed", green dot. The claim nudge disappears,
  since there is nothing left to claim.
- After the owner clicks Claim but before confirmation: the pill stays "Worker
  live" and the nudge stays, because the plugin cannot yet know the claim
  completed. This is honest rather than optimistic.

## Surface 3. The share popover

Locked:
- One combined view, built for a single link most of the time. With no link
  yet, the button is "Create link". With a link, you can add this thread to it
  or create a new link.
- The two sections "Existing tokens" and "Mint new share" collapse into one
  list. Each existing link is a row with its label and a read and a write
  button that add this thread to that link. Below the rows, a "Create new link"
  action with its own read or write choice.

Copy:
- No link yet: "No share link yet. Create one to share this thread." Button:
  "Create link".
- Create another once one exists. Button: "Create new link".
- While it runs: "Creating…".
- Done: "Link copied."
- Add succeeded: "Shared as read" or "Shared as write".
- Create worked but attaching the thread failed: "Link created, but adding this
  thread failed: <reason>".
- Footer: "Manage all links".
- Optional, not yet decided: a one-line helper under the choice, "read lets a
  guest watch. write also lets them send input."

## Surface 4. Mint and copy feedback, and persistence

Locked:
- Copy link works again after you create a link. The plugin holds the raw link
  in memory for the session so Copy link keeps working until bb restarts. It
  never touches disk.
- On restart, all links reset. This already falls out of the token store: the
  tokens live in memory and the HMAC key that matches a link is regenerated on
  every start, so links made before a restart cannot match after it.

Worker persistence and claiming: this grew into its own design. The worker has
two lifecycles, unclaimed (temporary, about 60 minutes, recreated each session)
and claimed (permanent, reused across restart). Holding both invariants (a
worker in use is always claimable, and a claimed worker is always reused) needs
a confirmed-claim signal the plugin does not have today. Full model, the hand-
computed traces, and the research task are in issue 28. Research subthread:
thr_vt4cfz8uxz, writing research/claim-confirmation.md.

Resolved: the design landed. Cloudflare gives no claim signal, so the plugin
proves a claim by the worker surviving past its 60-minute expiry. It persists a
claimed worker as url plus tunnelSecret plus metadata only, and holds unclaimed
workers in memory only. See issue 28's Answer and research/claim-confirmation.md.
One residual is open for you to accept: a restart inside the claim window can
orphan a just-claimed worker, bounded to under 60 minutes and recoverable.

## Surface 5. The token card, share rows, and delete confirm

Locked:
- Share rows show the thread title, not the raw thread id. The server resolves
  each shared thread's title when it builds the token list in listTokens, and
  falls back to the id only if the thread is gone. This needs the title added
  to the list data (the RPC contract carries no title today).
- Copy URL is always enabled for every link in the list. Because links reset on
  restart, every listed link is from this session and its raw link is held in
  memory (surface 4), so there is always a link to copy. The disabled state and
  the "shown once" tooltip are removed.
- Apply the link and create vocabulary here.

Copy:
- Delete confirm title: "Delete this link?"
- Delete confirm body: "This link and its N shares stop working right away.
  Anyone using it loses access."
- Empty state: "No threads on this link yet."

## Implementation status (2026-08-28)

Landed (owner-side frontend, in `nav-panel/tokens-panel.tsx` and
`share-popover/share-popover.tsx`): the link/create vocabulary sweep; surface 1
copy (create button, flash, copy-link tooltip); surface 2 pill states with the
"No shares yet" calm empty state and the claim nudge gated to when a worker
exists; surface 3 vocab and the contextual "Create link" vs "Create new link"
button and reworded section headers; surface 5 delete confirm, empty state, and
labels. tsc clean, 81 plugin tests pass, plugin reinstalled.

Deferred, because each needs server, contract, worker, or bb-API work, or a
visual check in the running app:
- Surface 1 mint-deploys-first (worker lifecycle; ties to 27/28).
- Surface 3 full combined-list visual restructure (needs a look in the app).
- Surface 4 copy-a-link-again (hold the raw link in memory server-side; new
  RPC/contract), and the persistence model (issue 28).
- Surface 5 thread titles resolved in listTokens (server + contract + a bb
  thread-title lookup), and Copy-URL-always-enabled (depends on surface 4).
- Surface 6 in full (guest read-composer hide, ended-access page) — guest-side
  shim/worker, and untestable while the tunnel is a 503 stub (issue 27).

## Surface 6. What the guest sees when they open the link

Grounding: the chrome shim today only hides four owner controls (New thread,
Search, Settings, plugin nav) with CSS, and it is permission-blind. It does not
handle the composer, add any framing, or give a guest-facing error page.

Locked:
- Read only guest: hide the message composer entirely. The guest sees the
  transcript with no message box. This needs the shim to know the guest's
  permission on the thread, which the worker already has from the authz check,
  so the shim must carry the per-thread perm and hide the composer for read.
  This extends the current permission-blind shim.
- No added chrome. Drop the guest straight into the scoped thread with no
  banner and no "you are viewing a shared thread" framing.
- A write guest's messages appear as normal user input, unmarked, as if the
  owner sent them. This fits pair prompting on a shared screen. Attribution of
  guest sends is out of scope for now.

Consistent with the no-chrome choice, and not yet confirmed with the owner:
- Ended or blocked access (the owner revoked the link) should show a minimal
  plain page, for example "This shared link is no longer active", with no bb
  chrome. A transient worker outage is not this case, because the app retries.

Follow-up beyond copy:
- The shim's hide list may be incomplete for a full guest lockdown. Native
  thread controls a guest must not use (for example delete thread, abort) are
  blocked by the mutation gate in issue 23, but the buttons may still be
  visible. Worth a pass to hide every owner-only control, not just the four.
