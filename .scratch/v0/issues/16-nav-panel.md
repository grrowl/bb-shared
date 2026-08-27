Status: claimed
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
