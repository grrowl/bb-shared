# BB Shared relay

A minimal Cloudflare Worker and Durable Object transport. The Worker contains
no guest authorization, cookies, response filters, or UI policy. The BB plugin
opens an outbound tunnel and enforces every guest request locally.

## Self-deploy

Install dependencies, authenticate Wrangler to the intended Cloudflare account,
and set a random pairing secret (at least 32 base64url characters):

```sh
npm ci
npx wrangler login
npx wrangler secret put TUNNEL_SECRET
npx wrangler deploy
```

Keep the secret and enter it together with the resulting HTTPS hostname in BB's
**Manage sharing → Connections → Add existing connection**. Do not put the secret
in invitation URLs. A custom domain can be the registered canonical hostname.
One relay accepts one active BB tunnel; duplicate aliases should not be registered
as independent connections.

## Contract

- `GET /__bb_shared/relay`: public service/version/protocol/relay identity.
- `/__tunnel?v=1`: WebSocket upgrade authenticated by `TUNNEL_SECRET`.
- All other requests: HTTP/WebSocket traffic forwarded over the active tunnel.
- No tunnel: HTTP 503 with `x-bb-tunnel-offline: 1`.
- `x-bb-shared-public-origin` is overwritten from the incoming URL.

`TUNNEL_DO` binds the SQLite Durable Object. `AUTHZ_TOKEN` is neither required nor
used. Runtime identity is not a credential; local registration also verifies
pairing and an end-to-end gateway readiness proof. Transport v1 is intentionally
small and stable, but future transport fixes may still require a relay update.

## Checks and artifact

```sh
npm run typecheck
npm test
npm run build
```

Tests run in both Node and actual `workerd` via Miniflare. Build generates the
plugin's embedded relay source; it does not deploy anything.
