// Cloudflare OAuth constants (issue 28).
//
// Authorization Code + PKCE against Cloudflare's dashboard OAuth server. Every
// value here is authoritative from the CF live-verification spike (TASK 2,
// research/cf-live-verification.md) — wrangler's shipped `@cloudflare/workers-auth`
// package plus the create-oauth-client doc. Where the earlier design
// (research/claim-confirmation.md §11.1) named different endpoints/scopes, THESE
// win (see the ticket's "OAuth constants — CORRECTED" appendix).
//
// The three endpoints are hardcoded; only the `client_id` is configurable (the
// grrowl client is not registered yet — see the plugin settings in `server.ts`).

/** Cloudflare dashboard OAuth endpoints (production). */
export const CF_OAUTH_ENDPOINTS = {
  /** Authorization endpoint the owner's browser is sent to. */
  authorize: "https://dash.cloudflare.com/oauth2/auth",
  /** Token endpoint — used for BOTH the auth-code and the refresh exchange. */
  token: "https://dash.cloudflare.com/oauth2/token",
  /** Refresh-token revocation endpoint (disconnect). */
  revoke: "https://dash.cloudflare.com/oauth2/revoke",
} as const;

/** Cloudflare REST API base (account/script/subdomain reads via the OAuth token). */
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// Scope identifiers — verified `resource:action` format (spike TASK 2). The
// design's `workers-platform.read/.write` names DO NOT EXIST on Cloudflare.
export const CF_SCOPES = {
  /** List/read the accounts the owner grants. */
  accountRead: "account:read",
  /** Read workers data (scripts, subdomain). */
  workersRead: "workers:read",
  /**
   * Update/delete scripts AND read/set the workers.dev subdomain — there is NO
   * standalone subdomain scope; it rides on this one. Requested as an OPTIONAL
   * scope so a cautious owner can grant read-only.
   */
  scriptsWrite: "workers_scripts:write",
} as const;

/**
 * Scopes always requested (read-only claim confirmation + hostname discovery
 * work with just these).
 */
export const CF_REQUIRED_SCOPES: readonly string[] = [
  CF_SCOPES.accountRead,
  CF_SCOPES.workersRead,
];

/**
 * Scopes requested as OPTIONAL. `workers_scripts:write` is what programmatic
 * redeploy/undeploy needs; a read-only owner may decline it. CF appends
 * `offline_access` itself to mint a refresh token — we never list it.
 */
export const CF_OPTIONAL_SCOPES: readonly string[] = [CF_SCOPES.scriptsWrite];

/**
 * Loopback redirect for the native/CLI auth-code flow. The port is FIXED, not
 * ephemeral: Cloudflare's OAuth server (Ory Hydra) matches `redirect_uris`
 * exactly, so the port the plugin listens on must equal a port registered on
 * the OAuth client. wrangler uses `http://localhost:8976/oauth/callback`; we
 * use our own default port and expose it as a plugin setting so the registered
 * redirect URI and the listener always agree. See `buildRedirectUri`.
 */
export const DEFAULT_OAUTH_CALLBACK_PORT = 8977;

/** Callback path component of the loopback redirect URI. */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/** The fixed script name we deploy under; the discovery key (§11.3). */
export const CF_WORKER_SCRIPT_NAME = "bb-shared-worker";

/**
 * The exact loopback redirect URI for a given port. MUST byte-match the
 * `redirect_uris` entry registered on the CF OAuth client.
 */
export function buildRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;
}
