// Connect-flow orchestration (issue 28 §11.2).
//
// Ties the pure pieces together into the two-phase browser flow:
//   1. beginConnect() builds the authorize URL and starts the loopback listener.
//      The caller opens the URL in the owner's browser.
//   2. complete() awaits the `/oauth/callback` hit, checks `state`, and exchanges
//      the code (+ PKCE verifier) for tokens.
//
// The split is what lets an RPC hand the authorize URL to the frontend to open,
// then finish the exchange in the background when the browser comes back.
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
  type PkcePair,
} from "./pkce";
import { waitForOAuthCallback } from "./loopback-server";
import { OAuthClient, type OAuthTokenResponse } from "./oauth-client";
import {
  CF_OAUTH_ENDPOINTS,
  CF_OPTIONAL_SCOPES,
  CF_REQUIRED_SCOPES,
  buildRedirectUri,
} from "./oauth-constants";

export interface PendingConnect {
  /** The URL the owner's browser must open to consent. */
  authorizeUrl: string;
  /** Await the browser callback and exchange the code for tokens. */
  complete(): Promise<OAuthTokenResponse>;
  /** Abort the loopback listener (owner closed the panel, etc.). */
  cancel(): void;
}

export interface BeginConnectArgs {
  clientId: string;
  port: number;
  /** Defaults to required + optional scopes; override for read-only. */
  scopes?: readonly string[];
  client?: OAuthClient;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  // ---- test seams ----
  pkce?: PkcePair;
  state?: string;
  createServerImpl?: Parameters<typeof waitForOAuthCallback>[0]["createServerImpl"];
}

/**
 * Start a connect attempt. Generates PKCE + state, builds the authorize URL, and
 * arms the loopback listener. `complete()` resolves the token response; the two
 * halves are exposed separately so the authorize URL can be opened before the
 * callback is awaited.
 */
export function beginConnect(args: BeginConnectArgs): PendingConnect {
  if (!args.clientId) {
    throw new Error(
      "Cloudflare OAuth client id is not configured (set it in the plugin settings)",
    );
  }
  const redirectUri = buildRedirectUri(args.port);
  const pkce = args.pkce ?? generatePkce();
  const state = args.state ?? generateState();
  const scopes = args.scopes ?? [...CF_REQUIRED_SCOPES, ...CF_OPTIONAL_SCOPES];
  const client =
    args.client ?? new OAuthClient({ fetchImpl: args.fetchImpl });

  const abort = new AbortController();

  const authorizeUrl = buildAuthorizeUrl({
    authorizeEndpoint: CF_OAUTH_ENDPOINTS.authorize,
    clientId: args.clientId,
    redirectUri,
    scopes,
    state,
    codeChallenge: pkce.challenge,
  });

  return {
    authorizeUrl,
    cancel: () => abort.abort(),
    async complete() {
      const { code } = await waitForOAuthCallback({
        port: args.port,
        expectedState: state,
        signal: abort.signal,
        timeoutMs: args.timeoutMs,
        createServerImpl: args.createServerImpl,
      });
      return client.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        clientId: args.clientId,
        redirectUri,
      });
    },
  };
}
