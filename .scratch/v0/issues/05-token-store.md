Status: resolved
Type: task
Blocked by: 04

In-memory token store — the service the RPC methods and the authz
endpoint call into.

- Data model per SPEC (Token, Share).
- Token id generation: `bbsh_` + 32 bytes CSPRNG, base64url.
- HMAC-SHA256 hash for comparison; raw token never persisted anywhere.
- HMAC key held per-process in memory (regenerated on plugin start).
- Random verb-noun label generator ("brave-otter", "silver-fox", …).
  Include a small vocab of adjectives + animals, dedupe against existing
  labels.
- Interface designed so a persistent backend can slot in later — expose
  an explicit `Store` interface, make all reads/writes async.
- Unit tests for CRUD, dedupe of labels, invariants (a Share's
  `thread_id` unique per token, etc.).

## Comments

## Answer

Landed the in-memory token store, wired every RPC handler in `server.ts`
except `getWorkerStatus` (left as a `notImplemented` stub — owned by 07),
and added a vitest suite. `tsc --noEmit` clean; `bb plugin build .` clean.

Files added:

- `plugin/lib/token-store.ts` — `Store` interface (all async), `InMemoryStore`
  implementation, `Token`/`Share` types, error taxonomy
  (`TokenNotFoundError` / `ShareNotFoundError` / `DuplicateShareError`),
  raw-token + id + HMAC helpers, label generator (`randomLabel`,
  `pickUniqueLabel`), `buildShareUrl` placeholder.
- `plugin/lib/token-store.test.ts` — 32 unit tests: id/raw-token entropy +
  uniqueness, HMAC determinism + key isolation, label generator +
  dedupe-with-suffix fallback, full CRUD, share invariants (thread_id
  unique per token; same thread_id allowed on different tokens), stored
  records cloned on read so external mutation can't leak in, deleting a
  token leaves no dangling references and frees its label.

`plugin/server.ts` changes: import the store + errors + `buildShareUrl`,
instantiate one `InMemoryStore` per plugin load, implement the seven CRUD
handlers, publish a `tokens-changed` realtime signal after each mutation,
and map store errors to friendly `Error.message`s. `mintToken` returns a
URL built with a `<worker-pending>` placeholder origin and a `TODO(issue
07)` for wiring the real worker URL.

Also added `vitest ^4.1.11` to `plugin/package.json` devDependencies.

Interpretation notes / surprises:

- SPEC and ticket 05 disagree slightly on `Token.id`: SPEC says
  `bbsh_ + 32B base64url` (looks like the raw bearer), ticket says raw
  token is NEVER persisted. Resolved by treating `Token.id` as a short
  non-secret public handle (`bbsh_<12>`) used for CRUD referencing, and
  the raw token (`bbsh_<43>`) as a separate value returned once from
  `mintToken` and used only to compute `hash = HMAC-SHA256(rawToken)`.
  The SPEC's field name + prefix are preserved; the byte count differs.
  Documented inline in `token-store.ts`.
- Caller-supplied labels bypass dedupe (v0 keeps this permissive; the
  RPC handler is the natural place for a policy pass later).
- Store methods return deep clones so a consumer mutating a returned
  `Token` can't corrupt store state — tested explicitly.
