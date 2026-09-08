# bb-shared

Share live [BB](https://getbb.app) threads through revocable invitations. Guests
use the BB interface with read or write access to the threads you choose.

## Install and build

Requires BB 0.40 or later and Node.js 20 or later.

```sh
npm ci
npm --prefix worker ci
npm run build
bb plugin install path:"$PWD/plugin" --yes
```

The plugin embeds a precompiled relay. Installed sharing does not run Wrangler
or require a sibling Worker source checkout.

## Share a thread

Open **Share this thread**, create an invitation, and choose read or write
access. In **Manage sharing**, deploy a temporary connection or register an
existing relay hostname and its pairing secret. Once a connection is ready,
copy the invitation from the thread popover. Optional audience labels help you
remember who received each invitation; they do not verify a recipient's identity.

A connection is a public HTTPS hostname tunneling to this BB instance. An
invitation is a bearer credential granting thread access. Invitations work on
all connections registered with this instance; the default connection chooses
the hostname used when copying invitations. A hostname alone grants no access.

Opening another invitation on the same hostname adds its valid permissions to
the browser session. The strongest current grant wins. Revoked invitations stop
contributing access, including to open realtime connections. Sessions expire
after 30 days unless renewed by opening an invitation, and survive plugin
restarts. Cookies are private to each hostname. Open the first invitations sequentially;
two simultaneous first opens can race before a session cookie exists. Copy an invitation from the
owner's sharing UI; the guest's clean address bar URL is not an invitation.

## Connections and Cloudflare

BB opens an outbound WebSocket to each relay, so ordinary NAT/CGNAT needs no
inbound port forwarding. **Ready** means the authenticated tunnel has reached
this plugin's guest gateway and the gateway can reach BB. Network outages show
as offline or reconnecting without deleting the saved connection.

Temporary Cloudflare accounts must be claimed within 60 minutes to keep their
resources. Claiming happens in Cloudflare and does not grant the plugin ongoing
account access. Claim status does not control reconnects. An expired claim window
is not proof that a saved hostname was deleted.

Self-deploy the Worker using [worker/README.md](worker/README.md), then register
its hostname and `TUNNEL_SECRET` in connection management. Registration checks
compatibility, pairing, and the complete tunnel before saving. A custom domain
works as the canonical registered hostname. Only one connection per relay is
allowed: remove the existing connection before changing its canonical hostname.

Removing a connection disconnects it locally; it does not delete a Cloudflare
Worker. Changing the default does not repair old URLs if their hostname is gone.
If you lose local invitation state, re-registering a relay cannot recover those
invitations: restore encrypted local storage and its device key, or create new
invitations.

## Security and compatibility

Every tunneled request passes through a local guest gateway. It authorizes
thread access, restricts API routes, filters responses and realtime events, and
prepares the guest UI before proxying to BB. There is no unrestricted tunnel
fallback to the owner's server. The Worker is a transport relay and holds only
the pairing secret; it contains no invitation policy or BB plugin API token.

Write invitations support text messages under the owner’s existing execution
policy; attachments and execution overrides are not supported.

Invitation bearers, browser sessions, grants, and connection credentials are
stored encrypted with the local device key. Anyone holding an invitation has
its access until revoked. The relay terminates TLS and can see shared traffic;
use a relay you trust.

This is a pre-1.0 protocol change. Old policy-bearing Workers and token-in-path
URLs are unsupported. Deploy the current relay and distribute current query-form
invitations. Existing local invitation records are retained, but old Worker/OAuth
records are not imported into the new connection registry.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Worker tests include actual `workerd` execution. Gateway tests use real HTTP and
WebSocket connections. See [the design review](docs/1.0-design-review.md) for the
original findings and [implementation notes](docs/1.0-implementation.md) for the
current boundaries and remaining release validation.
