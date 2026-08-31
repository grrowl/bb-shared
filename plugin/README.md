# bb-plugin-shared

Scaffold for the `bb-shared` plugin — see `../SPEC.md` for the full design
and `../.scratch/v0/map.md` for the feature map. This is the deliverable of
issue 04; the RPC contract is complete and typed, but every handler still
throws `not implemented: <name>`. Downstream tickets fill the bodies:

| Ticket | Fills |
|---|---|
| 05 | in-memory token store + `mintToken` / `listTokens` / share CRUD |
| 06 | `/authz` HTTP endpoint (worker → plugin scope check) |
| 07 | Cloudflare worker deploy + `getWorkerStatus` |
| 15 | `experimental_threadHeaderAction` popover in `app.tsx` |
| 16 | management panel component in `app.tsx` |

## Layout

```
plugin/
  package.json         manifest (name/description/branding + bb.server + bb.app)
  server.ts            RPC contract + stub handlers (throw "not implemented")
  app.tsx              frontend surfaces (navPanel, threadHeaderAction, palette)
  tsconfig.json        typecheck config (strict, JSX react-jsx, @/*  paths)
  components/ui/       vendored shadcn components (issues 15/16 will use them)
  hooks/, lib/         vendored helpers
  dist/                built bundle (server.js, app.js, app.css + meta.json)
```

## Install / local dev

Requires `bb` >= 0.40 on the machine (`bb --version` to check).

```
cd plugin/
npm install                          # first time only — installs SDK + deps
bb plugin build .                    # produces dist/
bb plugin install . --yes            # registers as path source; runs from src
bb plugin list                       # confirms "shared@0.1.0 running"
bb plugin logs shared                # bb.log output from server.ts
bb plugin remove shared              # tears the local install back down
```

Iterative development:

```
bb plugin dev .                      # watches sources, rebuilds + reloads
```

`bb plugin dev` reloads the running plugin on every save; the frontend
picks up the new bundle on the next SPA reload.

## Verifying the scaffold

The scaffold is intentionally empty — every RPC call from the app throws.
To sanity-check the wire without adding real bodies, from a bb terminal:

```
curl -sS -X POST http://127.0.0.1:38886/api/v1/plugins/shared/rpc/listTokens \
     -H 'content-type: application/json' -d 'null'
# → { "ok": false, "error": { "message": "not implemented: listTokens", ... } }
```

If the plugin loaded and RPC is registered, that "not implemented" reply is
the success signal for issue 04.

## Cloudflare worker lifecycle

bb-shared never authorizes or manages a user's Cloudflare account. The owner can
open the owner-only claim link; Cloudflare transfers the whole temporary account
and preserves the worker's `workers.dev` hostname. bb-shared cannot observe or
confirm that action.

The saved endpoint is reused whenever the exact worker probe returns `401`
`{ "error": "token_missing" }`, even after the temporary claim TTL. A failed
probe is **Offline**, not a reason to discard or replace the record: it is
checked again periodically, including with no shares. **Recreate worker** is the
only replacement action. It creates a new hostname; existing copied links still
target the old worker, which Cloudflare does not delete automatically.

## Notes for downstream issues

- **RPC method names**: camelCase (matches the ticket). The bb host only
  requires `/^[a-zA-Z0-9_-]+$/` — automations uses `_`, tasks uses `_`, this
  plugin uses camelCase; pick one and stick with it.
- **Realtime channels**: `REALTIME_CHANNELS` in `lib/realtime-channels.ts`
  names the channels the frontend subscribes to (`tokens-changed`,
  `worker-changed`). Publish from wherever the mutation
  happens.
- **In-memory state**: SPEC.md §"Data model" is explicit — no SQLite in v0.
  Use a plain `Map<string, Token>` in the factory closure; state dies on
  reload, which is fine for v0.
- **Void returns**: the wire envelope has no `void`, so the contract uses
  `{ ok: true }` for the seven side-effecting methods (matches
  `plugins/automations` in the bb repo).
- **Vendored components**: `components/ui/`, `hooks/`, `lib/` are the
  scaffold's shadcn starter set. Keep them — issues 15 and 16 use `Button`,
  `AlertDialog`, `DropdownMenu`, etc.
