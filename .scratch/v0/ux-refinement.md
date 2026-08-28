# bb-shared UX refinement

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
