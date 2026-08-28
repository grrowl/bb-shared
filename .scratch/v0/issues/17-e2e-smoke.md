Status: resolved
Type: task
Blocked by: 07, 09, 10, 11, 12, 14, 15, 16

End-to-end smoke test — walk through the full flow from a clean install.

- Install plugin.
- Deploy worker (verify latency and URL).
- Mint a token, add current thread as `write`.
- Copy URL, open in incognito browser.
- Verify: sidebar shows only the shared thread; Settings/Extensions/New-Thread
  hidden; can view transcript; can send a message and it appears in
  the owner's view.
- Add a second thread as `read`; verify: sidebar updates without reload,
  guest can view but not send.
- Remove one share, delete the token — verify guest is booted.

Documented as a manual runbook first; automate later if worth it.

## Comments

## Answer

Delivered the manual runbook at [`docs/e2e-runbook.md`](../../../docs/e2e-runbook.md)
(~360 lines) and created the top-level [`README.md`](../../../README.md). Every
step, expected result, and failure indicator is cross-checked against delivered
code and the resolved ticket answers (04–19), not against SPEC prose alone. The
e2e was **not** actually run (no CF egress in the sandbox, per the ticket).

Runbook structure: Prerequisites → Setup → Deploy worker → 8-step numbered
walk-through → verification checklist → known v0 limitations → troubleshooting.

**Drift flagged in the runbook (not papered over):**

1. **Plugin id `shared` vs `bb-shared` — load-bearing.** The npm package is
   `bb-plugin-shared`, so bb mounts the plugin under **`shared`** (confirmed by
   04's `shared@0.1.0 running` and the scaffold curl `/plugins/shared/rpc/…`).
   But issues 06/10/16 + SPEC write the authz mount as
   `/api/v1/plugins/**bb-shared**/http/authz` and the nav panel as
   `/plugins/bb-shared/tokens`. If the worker calls `bb-shared` while the plugin
   mounts at `shared`, **every guest request fails authz closed → 403**. Runbook
   opens with a "verify the mount first" block and lists this as troubleshooting
   symptom #1. Recommend a v0.1 ticket to align on one id.
2. **"Sidebar updates without reload" is owner-side only.** The ticket's step 6
   attributes it to `useRealtime("tokens-changed")` — but that hook is in the
   plugin frontend, which is **suppressed for guests** (`/api/v1/plugins` → []).
   It updates the owner's panel. The guest's WS scope is fixed at upgrade time
   (11), so a mid-session share addition needs a guest **reload** to appear.
3. **Revocation (steps 7–8) is pull-based, not a live eviction.** No proactive
   socket teardown on removeShare/deleteToken; enforcement is at the next
   request (403/404) and on reload. 11 deliberately silent-drops the revoked
   subscribe frame ("stale UI beats a disconnect loop"). "Guest is booted" is
   therefore accurate for *new* requests, not for an already-rendered tab.
4. **Lazy deploy fires on `mintToken` only**, not `openShareDialog` as SPEC
   also allows — opening the popover doesn't deploy; minting does.
5. Minor, already documented in prior answers, restated in limitations:
   `defaultKeybindings`/`keybindingOverrides` + in-scope `sources` kept in
   `/system/config` (09); `thread_id` shown not title (16); Copy-URL only for
   session-minted tokens (16); worker record persists in `bb.storage.kv`, the
   concrete surface behind SPEC's "PluginSettings" (07).

Pointers: `~/grrowl/bb-shared/docs/e2e-runbook.md`, `~/grrowl/bb-shared/README.md`.
