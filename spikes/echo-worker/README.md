# echo-worker — bb-shared spike 01 PoC

Minimal Cloudflare Worker used to validate that the "temporary deployments
for agents" flow supports the primitives our real transport needs:

- HTTP handling
- WebSocket upgrade + echo
- Durable Object binding + migration (proves DO wiring survives the temp
  provisioning pipeline)

Full findings in [`../../research/cf-temp-deployments.md`](../../research/cf-temp-deployments.md).

## Layout

```
src/worker.ts       # Worker entry: fetch + EchoRoom DO
wrangler.toml       # DO binding, migration, workers_dev = true
scripts/ws-smoke.mjs # Node WebSocket smoke test
package.json
tsconfig.json
```

## Local verify

```
npm install
npm run dev                              # wrangler dev — http://127.0.0.1:8787
# in another shell:
curl -sSf http://127.0.0.1:8787/         # -> bb-shared echo worker OK
curl -sSf http://127.0.0.1:8787/do/echo  # -> do OK
BASE_WS=ws://127.0.0.1:8787 npm run smoke:ws
# expected stdout: recv: echo: hello
```

## Deploy via temp-account (runbook)

Requires:

- Wrangler ≥ 4.102.0 (the `--temporary` flag)
- Node 20+
- Network egress to `api.cloudflare.com` (see "Blocker" below)

```
npm install
npx wrangler deploy --temporary
```

Wrangler prints:

- A `https://bb-shared-echo.<sub>.workers.dev` URL
- A claim URL like `https://dash.cloudflare.com/claim-preview?claimToken=...`

Smoke-test the deployed worker:

```
URL=https://bb-shared-echo.<sub>.workers.dev
curl -sSf "$URL"
curl -sSf "$URL/do/echo"
BASE_WS="wss://${URL#https://}" npm run smoke:ws
```

## Blocker

The `mactom` agent sandbox has an empty network allowlist for `WebFetch`, and
outbound curl to `api.cloudflare.com` from the sandboxed `Bash` tool is
similarly restricted. The deploy was not executed from this session. Run the
runbook above from a machine with open egress — the code is complete and
self-contained.

## For the real deploy path

The plugin should not shell out to wrangler in production. Use the REST +
`cloudflare` SDK path documented in `research/cf-temp-deployments.md`
(section "Recommended shape for our deploy code"). This spike keeps
`wrangler deploy --temporary` as the fast validation route because it wraps
the challenge + provisioning + upload in one command; the plugin will
reimplement that with more control (captures the claim URL, retries, etc.).
