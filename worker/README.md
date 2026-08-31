# bb-shared Worker

This Cloudflare Worker is the public half of bb-shared. It accepts a guest
link, verifies its scope with the owner's local plugin over a tunnel, and
proxies only the permitted bb traffic.

It is bundled and deployed by the plugin. Operators do not need a Cloudflare
account, Wrangler login, or manual production deployment.

## Local development

```sh
cd worker
npm install
printf 'TUNNEL_SECRET=development-only\nAUTHZ_TOKEN=development-only\n' > .dev.vars
npm run dev
```

Without a connected local `SharedTunnel`, valid guest requests return a tunnel
offline response. That is expected for a standalone Worker.

## Checks

```sh
npm run typecheck
npm test
```

## Runtime bindings

| Binding | Purpose |
| --- | --- |
| `TUNNEL_SECRET` | Authenticates the owner's tunnel connection to `/__tunnel`. |
| `AUTHZ_TOKEN` | Authenticates Worker-to-plugin authorization requests. |
| `TUNNEL_DO` | Durable Object that holds the active tunnel connection. |

The plugin provisions both secrets as Cloudflare `secret_text` bindings. Do
not commit `.dev.vars` or deploy the Worker with hand-written credentials.
