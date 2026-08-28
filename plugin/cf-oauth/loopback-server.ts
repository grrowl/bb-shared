// Loopback callback listener for the auth-code flow (issue 28 §11.2).
//
// The native/CLI OAuth pattern: the plugin listens on a FIXED loopback port and
// registers `http://127.0.0.1:<port>/oauth/callback` as the client's redirect
// URI. After the owner consents, Cloudflare redirects their browser to that URL
// with `?code=…&state=…`; this tiny server captures the code, verifies `state`,
// shows the owner a plain "you can close this tab" page, and resolves.
//
// The port is fixed (not ephemeral) because Cloudflare matches redirect_uris
// exactly — see oauth-constants.ts. The browser must be on the same machine as
// the bb server (the standard loopback assumption; documented for the owner).
import { createServer, type Server } from "node:http";
import { OAUTH_CALLBACK_PATH } from "./oauth-constants";

export class LoopbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopbackError";
  }
}

export interface CallbackResult {
  code: string;
  state: string;
}

const OK_HTML =
  "<!doctype html><meta charset=utf-8><title>bb-shared</title>" +
  "<body style=\"font-family:system-ui;padding:2rem;max-width:32rem\">" +
  "<h1>Cloudflare connected</h1>" +
  "<p>You can close this tab and return to bb.</p>";

const ERR_HTML =
  "<!doctype html><meta charset=utf-8><title>bb-shared</title>" +
  "<body style=\"font-family:system-ui;padding:2rem;max-width:32rem\">" +
  "<h1>Connection failed</h1>" +
  "<p>Something went wrong. Return to bb and try again.</p>";

/**
 * Listen on the loopback callback port and resolve with the `{ code, state }`
 * from the first `/oauth/callback` hit whose `state` matches `expectedState`.
 * Rejects on: a provider `error=` param, a `state` mismatch (CSRF guard), the
 * abort signal firing, or the timeout. Always closes the server before settling.
 */
export function waitForOAuthCallback(args: {
  port: number;
  expectedState: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injectable server factory for tests; defaults to node:http. */
  createServerImpl?: typeof createServer;
}): Promise<CallbackResult> {
  const timeoutMs = args.timeoutMs ?? 5 * 60_000; // the ~5-min authorize window
  const make = args.createServerImpl ?? createServer;

  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    let server: Server;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      try {
        server.close();
      } catch {
        // server may not be listening yet; nothing to clean up
      }
      fn();
    };

    const onAbort = () =>
      finish(() => reject(new LoopbackError("connect cancelled")));

    const timer = setTimeout(
      () => finish(() => reject(new LoopbackError("connect timed out"))),
      timeoutMs,
    );
    timer.unref?.();

    server = make((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${args.port}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" }).end(ERR_HTML);
        finish(() =>
          reject(
            new LoopbackError(
              `authorization denied: ${url.searchParams.get("error_description") ?? error}`,
            ),
          ),
        );
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "content-type": "text/html" }).end(ERR_HTML);
        finish(() =>
          reject(new LoopbackError("callback missing code or state")),
        );
        return;
      }
      if (state !== args.expectedState) {
        // CSRF guard: a callback whose state we did not issue is rejected.
        res.writeHead(400, { "content-type": "text/html" }).end(ERR_HTML);
        finish(() => reject(new LoopbackError("state mismatch")));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(OK_HTML);
      finish(() => resolve({ code, state }));
    });

    server.on("error", (err) =>
      finish(() =>
        reject(new LoopbackError(`loopback listener failed: ${err.message}`)),
      ),
    );
    if (args.signal?.aborted) {
      onAbort();
      return;
    }
    args.signal?.addEventListener("abort", onAbort, { once: true });
    server.listen(args.port, "127.0.0.1");
  });
}
