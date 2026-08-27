Status: resolved
Type: task
Blocked by: 04

`navPanel` at `/plugins/bb-shared/tokens` — the management console.

- Grouped by token. Per-token:
  - Label (inline-renameable).
  - Share list: thread name + perm chip.
  - Per-row: remove, upgrade (read→write), downgrade (write→read).
  - Copy-URL, delete-token (with confirm dialog).
- Header: "Mint new" + live worker status pill.
- Live-update via `useRealtime()`.
- Confirm dialogs via vendored shadcn `AlertDialog`.

Refs: `plugins/automations/app.tsx` in bb repo for CRUD template.

## Comments

## Answer

Built the `navPanel` management console at `/plugins/bb-shared/tokens`.

**Files** (all new work confined to `app.tsx` + `plugin/nav-panel/`, per the
concurrency constraint with 06):

- `plugin/nav-panel/tokens-panel.tsx` — the console. Exports `TokensPanel`.
- `plugin/nav-panel/alert-dialog.tsx` — vendored shadcn `AlertDialog`
  (radix `@radix-ui/react-alert-dialog`, already a devDep). The repo's
  `components/ui` set had `Dialog` but no `AlertDialog`; this one mirrors
  `dialog.tsx`'s `usePortalScopeProps()` handling so the portaled overlay +
  content keep the plugin's compiled style scope. Kept under `nav-panel/`
  rather than `components/ui/` to honour the file-touch constraint.
- `plugin/app.tsx` — dropped the placeholder `TokensPanel`/`useSharedRpc`
  scaffold; imports the real panel. Registration block untouched.

**Delivered against the ticket:**

- Grouped by token (one card each). Per-token: inline-renameable label
  (`RenameableLabel` → `renameToken`; click/pencil → input, Enter/blur commits,
  Escape reverts, no-op rename skips the RPC).
- Share list: one row per thread, perm chip (read = muted, write = amber),
  clickable thread id → `navigate.toThread`. Per-row **remove**
  (`removeShare`) and a single **Upgrade/Downgrade** button that flips
  read↔write via `updateShare`.
- Per-token **Copy URL** and **delete-token** behind an `AlertDialog` confirm
  (dialog stays mounted during the in-flight delete so the pending state shows).
- Header: **Mint new** (`mintToken`, copies the returned guest URL) + a live
  **worker status pill** calling `getWorkerStatus`. The stub currently rejects
  with "not implemented" — matched loosely and rendered as a calm
  "Worker not deployed" state rather than an error. Real `{healthy,url}`
  responses render healthy/unhealthy; non-stub rejections render "unreachable".
- CF **claim.url** nudge: `WorkerClaimNudge` reads `claim.url` defensively off
  the status (the contract's `WorkerStatus` is `{url?,healthy}`; 07 may widen
  it) and, when present, offers a "Claim this worker" link via
  `navigate.openUrl` — never rendered as raw copyable text, per SPEC's
  bearer-credential rule. Placeholder text otherwise.
- Live-update: `useRealtime("tokens-changed")` (inlined string + comment, same
  pattern as `share-popover.tsx`, because `REALTIME_CHANNELS` from `server.ts`
  breaks the browser bundle — ticket 18) refetches the list; the pill also
  subscribes to `"worker-changed"`.

**Copy-URL caveat (by design):** `listTokens` never returns the raw bearer
(SPEC §"Data model" — only the HMAC is persisted, the raw token is returned
once from `mintToken`). So the guest URL is only recoverable for tokens minted
in this session; those are cached in a `tokenId → url` map and Copy URL is
enabled for them. For pre-existing tokens the button is disabled with a
tooltip explaining a re-mint is needed, rather than fabricating a URL.

**Thread names:** the RPC contract carries no thread title, only `thread_id`,
so the id is shown (monospace) and links to the thread. A friendlier name would
need a thread-lookup method the v0 contract doesn't expose.

**Verification:** `npx tsc --noEmit` → exit 0; `bb plugin build .` → exit 0
(`dist/app.js`, `dist/app.css` emitted, panel strings + tailwind classes
present). Did not touch `plugin/server.ts` (owned by 06) or `plugin/lib/`
(shared-tunnel.ts is 14's WIP).
