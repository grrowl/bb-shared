Status: resolved
Type: research

Determine whether bb's local tunnel client (`plugins/connect/src/tunnel.ts`
in the bb repo, cloned locally at `/tmp/claude/bb-research/bb/`) can be
pointed at an alternate worker URL via config, or whether we need to
fork it.

Answer:

- Read the tunnel client end-to-end. What are the entry points?
- Identify all hardcoded `getbb.app` references.
- Identify the auth handshake to the worker (bearer, tunnel identifier).
- If config-based: what env var / setting overrides the target?
- If fork: minimal patch to redirect + swap credential model.
- Can two tunnel clients coexist on the same bb (bb's connect to the
  real bridge + our fork to our worker)? If not — what has to be
  mutually exclusive?
- **Origin-guard check**: does a guest request tunneled through our
  worker fork pass the local bb server's Origin check at
  `apps/server/src/browser-request-guard.ts`? What Origin header must
  the tunnel client emit or preserve for the local bb to accept it?

Deliverable: `research/tunnel-client.md` with a specific recommendation
(config knob vs fork), the exact code paths involved, the Origin-guard
answer, and a rough implementation shape for issue 14.

## Comments

## Answer

Full write-up: [`research/tunnel-client.md`](../../../research/tunnel-client.md).

**Recommendation: fork-lite** (not config, not full fork).

- No production config knob exists in `plugins/connect` to redirect at an
  alternate worker. The only override — `BB_DEV_CONNECT_BASE_URL` — is
  hard-locked to `http://bb.localhost:<port>` under `NODE_ENV=development`,
  and it only affects the redeem/pair flow, not the tunnel dial.
- Reusing `plugins/connect`'s tunnel by hijacking its KV credential would
  stomp the user's real bb-connect pairing and drag in shares/hosts/CLI we
  don't need.
- Full fork of `plugins/connect` is ~2500 LOC of unrelated surface (shares,
  machine codes, panel, CLI, host enrolment).
- Ship a ~120-line `SharedTunnel` inside bb-shared that vendors bb's
  transport-generic packages `packages/tunnel-client` +
  `packages/tunnel-contract` (~750 LOC total, both `private: true` workspace
  packages — vendoring is mandatory), and wraps them with our own bearer +
  worker URL. Coexists cleanly with real `bb connect` (separate plugin,
  separate KV, both dial the same loopback).

**Origin-guard: passes.** bb's tunnel-client already rewrites the visitor's
`Origin` header from the public origin to the loopback origin
(`packages/tunnel-client/src/headers.ts:15`), and our `SharedTunnel` uses
the same code — as long as `publicOrigin` is set to the worker's origin
and `loopbackOrigin` is `bb.server.loopbackBaseUrl`, the rewrite fires and
`browserRequestProblem` accepts the request. **What must be preserved**:
the CF worker must forward the guest's `Origin: https://<worker-host>`
unchanged (or unconditionally set it to its own public origin) before
sending the request into the tunnel — anything else and the substitution
doesn't fire and bb 403s.
