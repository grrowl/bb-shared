# 32 — Server: listTokens returns per-token URL + per-share thread title

Part of the 2026-08-30 UX re-grill (see `.scratch/v0/ux-refinement.md`, the top
"Re-grill 2026-08-30" section). This is build step 1 and the foundation the
popover (issue 34) and panel (issue 35) reworks depend on. Owner-side only.

## Goal

Two additions to the `listTokens` RPC so the owner UI can (a) always copy a
link's guest URL and (b) show thread titles instead of raw ids.

1. **Per-token guest URL.** Because links are ephemeral (the HMAC key and tokens
   die on bb restart — see server.ts:231 comment and the token store), every
   link that exists is from the current session, so its raw bearer is safe to
   hold in memory and hand back to the owner UI. Hold the raw token (or the
   fully-built guest URL) in the in-memory store keyed by token id, and surface
   it on each token in `listTokens`. This lets "Copy URL" work for every listed
   link, removing today's disabled state (tokens-panel.tsx ~line 739/746) and
   the frontend `mintedUrls` map (tokens-panel.tsx:831).

2. **Per-share thread title.** Resolve each shared thread's current title when
   building the token list, falling back to the raw `thread_id` if the thread is
   gone. Add it to each share in the output.

## Current shape (plugin/server.ts)

- `shareSchema` (server.ts:45): `{ thread_id, project_id, perm, added_at }`.
- `tokenSchema` (server.ts:53): `{ id, hash, label, shares[], created_at }`.
- `listTokens` (server.ts:143): `input: null`, `output: { tokens: Token[] }`.
- The store is `InMemoryStore` from `./lib/token-store` (server.ts:233). The raw
  token is currently only returned once from `mintToken` (see `MintResult` and
  `buildShareUrl` in token-store.ts). The store persists only the HMAC `hash`.

## Required changes

- **Contract:** add `url: z.string().optional()` to `tokenSchema` (optional so
  any future persisted-but-secret token degrades gracefully), and add
  `title: z.string().optional()` to `shareSchema`. Keep both optional to avoid a
  breaking wire change and so a resolve failure never breaks the list.
- **Store:** extend the in-memory store to retain the raw token per token id for
  the session (never persisted to disk; dies with the process, same lifetime as
  today's tokens). Expose it so the RPC handler can build the URL via the same
  `buildShareUrl` path `mintToken` uses (reuse it — do not duplicate URL logic).
  The URL must match exactly what mintToken returns (the `?token=` query form
  that the worker turns into a session cookie).
- **Thread title lookup:** find the bb plugin API that resolves a thread's title
  from its id (inspect `BbPluginApi` in `@get-bb/plugin-sdk` and how other
  plugins do it; the `bb` handle is available in the plugin factory,
  server.ts:228). Resolve titles when handling `listTokens`. If lookup fails or
  the thread is gone, omit `title` (frontend falls back to the id). Do NOT block
  the whole list on one slow/missing lookup — resolve defensively.
- **listTokens handler:** populate `url` per token and `title` per share.

## Constraints / security

- The raw guest URL is an owner-only value. `listTokens` is an owner RPC; the
  worker deny-closes every `/api/v1/plugins/shared/rpc/*` path to guests (M2, see
  authz), so guests cannot reach it. Do not add the URL to any realtime
  broadcast or to any guest-reachable path. This change is security-relevant and
  will get a careful review — keep the blast radius to listTokens only.
- Never write the raw token to disk or `bb.storage.kv`. Memory only.
- Keep the URL derivation in one place (`buildShareUrl`), consistent with
  mintToken, so the popover/panel copy exactly the same link.

## Acceptance

- `listTokens` returns each token with a `url` that equals the mintToken URL for
  that token, and each share with a `title` (or omitted if unresolved).
- Existing tests still pass; add unit coverage: (a) listTokens includes a url for
  a minted token, (b) title resolves and falls back to id when the thread is
  absent, (c) the raw token is never persisted (store round-trip / no disk write).
- `tsc` clean. Run the plugin test suite. Do NOT change the frontend in this
  issue — panel/popover consume the new fields in issues 34/35.

## Notes for the implementor

- You inherit no prior context. Read `.scratch/v0/ux-refinement.md` (top
  section) for the model, and SPEC.md's data-model section for the token
  invariants. Match the surrounding code's style and comment density.
- Report back: the exact new contract shape, the bb API you used for title
  lookup, and any invariant you had to bend.
