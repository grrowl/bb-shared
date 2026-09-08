# BB Shared plugin

The plugin owns connections, invitations, encrypted browser sessions, and the
local guest gateway. Every relay stream targets that gateway rather than the
unrestricted BB loopback server. Scope enforcement and guest UI changes can ship
with plugin updates without updating deployed relays.

Run checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
```

The build compiles the Worker into `worker-source.generated.ts` and embeds it
in the plugin server bundle. `bb plugin build plugin` alone uses the existing
generated source; use `npm run build` whenever changing relay code.

Connection registration requires a canonical HTTPS hostname, the relay pairing
secret, a compatible identity, an authenticated WebSocket, and a readiness proof
from this gateway. Connection and session records are encrypted through BB KV
storage with a device-bound key. Losing that key requires restoring it or
recreating local state; a relay contains no backup of invitations.

The owner-only RPC contract remains in `server.ts`. Guest access is served by
a private loopback listener created after BB starts listening, with disposal
closing tunnels, sessions' sockets, and pending requests.
