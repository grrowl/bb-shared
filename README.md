# bb-shared

Share live [bb](https://getbb.app) threads with a scoped, revocable link.
Guests get the real bb interface, limited to the threads you choose. Each link
can grant read-only or write access per thread.

## What it does

- Share one or more threads through a named link.
- Change access or revoke a link at any time.
- Give guests a live, scoped bb view; write links can send user messages.
- Create a temporary Cloudflare Worker automatically. Claim it to keep its
  stable `workers.dev` hostname after Cloudflare's temporary period.
- Keep shared links across bb and plugin restarts. Link credentials are stored
  in an encrypted, device-bound record on the owner's machine.

## Install

Requirements: a current bb installation and Node.js 20 or later.

```sh
bb plugin install https://github.com/grrowl/bb-shared --yes
```

bb clones the repository, installs the dependencies, and builds the plugin for
you.

Open a thread in bb and select **Share this thread**. The first new link
creates a temporary Cloudflare Worker. Use **Shared threads** in the sidebar to
see links, their worker, and the claim action.

## Worker lifecycle

bb-shared does not ask for access to your Cloudflare account. It creates a
temporary worker instead. Cloudflare may clean up an unclaimed worker after 60
minutes; **Claim your worker** transfers that temporary account to you and
keeps its hostname.

bb-shared cannot confirm whether a claim completed. It keeps checking the
saved worker and reports it as online or offline. **Recreate** explicitly makes
a new worker and hostname; existing links keep pointing to the old worker.

## Security model

Shared URLs are bearer credentials: anyone who has a link has the access it
grants until you change or revoke it. The plugin stores those credentials and
their grants encrypted with a key bound to the owner's device (macOS Keychain
where available). They are never sent to guests except as the URL they use.

The Cloudflare Worker enforces scope before proxying to the local bb server.
It filters guest-visible data and WebSocket traffic, and keeps owner-only bb
routes and plugin RPCs out of reach.

This is early software. Do not share threads containing secrets or other data
you would not want a link recipient to read.

## Development

The repository root is the plugin, so a local checkout installs from its own
directory.

```sh
git clone https://github.com/grrowl/bb-shared.git
cd bb-shared
npm install
(cd worker && npm install)
bb plugin install path:"$PWD" --yes
```

Then, to check and rebuild a change:

```sh
npm run typecheck
npm test
(cd worker && npm run typecheck && npm test)
bb plugin build .
bb plugin reload shared
```

See [plugin/README.md](plugin/README.md) and [worker/README.md](worker/README.md)
for component-specific notes.

## License

[MIT](LICENSE)
