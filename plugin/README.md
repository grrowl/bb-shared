# bb-shared plugin

The bb plugin owns the sharing UI, scoped-link authorization, durable link
state, Cloudflare Worker lifecycle, and the local half of the guest tunnel.

## Development

Install dependencies from the repository root, then build and install the
plugin as a local source:

```sh
npm install
bb plugin build plugin
bb plugin install path:"$PWD/plugin" --yes
```

For iterative work:

```sh
bb plugin dev plugin
```

Run its checks with:

```sh
npm exec --workspace=bb-plugin-shared -- tsc -p tsconfig.json --noEmit
npm exec --workspace=bb-plugin-shared -- vitest run
```

## Key boundaries

- Shared-link bearers and grants are persisted as one device-key-encrypted
  record. The in-memory authorization hashes are rebuilt on each start.
- The Worker record persists its URL, tunnel secret, and temporary claim URL;
  it contains no Cloudflare account credential.
- `AUTHZ_TOKEN` authenticates Worker-to-plugin scope checks. It is obtained
  from bb at deployment time and never returned to guests.
- A worker is replaced only by the explicit **Recreate** action. An offline
  result does not delete its saved record.

The plugin id is `shared` (derived from the `bb-plugin-shared` package name).
