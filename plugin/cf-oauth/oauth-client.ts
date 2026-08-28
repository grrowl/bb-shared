// Cloudflare OAuth token client (issue 28).
//
// The three token-endpoint exchanges of a public PKCE client — auth-code →
// tokens, refresh → tokens, and revoke — with NO client_secret (public client,
// `token_endpoint_auth_method: "none"`; spike TASK 2). Refresh-token ROTATION
// is handled per RFC 6749 §6: Cloudflare (Ory Hydra) MAY return a new
// `refresh_token` on any exchange; callers must persist the new one when present
// and keep the old one when absent. `applyRefreshRotation` encodes that rule.
//
// Injectable `fetchImpl` so the whole client unit-tests against a mock fetch —
// there is no registered client yet, so a live exchange cannot be exercised
// (item 5 of the ticket): the shape is what we can test.
import { CF_OAUTH_ENDPOINTS } from "./oauth-constants";

/** Token-endpoint success payload we consume. */
export interface OAuthTokenResponse {
  /** Short-lived bearer for CF API calls. Memory-only, never persisted. */
  accessToken: string;
  /** Rotating long-lived credential. Persisted (encrypted, issue 29). */
  refreshToken?: string;
  /** Seconds until the access token expires (CF returns `expires_in`). */
  expiresInSeconds?: number;
  /** Space-joined scopes actually granted (used to detect write consent). */
  scope?: string;
  tokenType?: string;
}

export class OAuthClientError extends Error {
  constructor(
    message: string,
    /** True when the refresh token is revoked/invalid → drop to not-connected. */
    readonly invalidGrant: boolean = false,
  ) {
    super(message);
    this.name = "OAuthClientError";
  }
}

export interface OAuthClientOptions {
  fetchImpl?: typeof fetch;
  endpoints?: typeof CF_OAUTH_ENDPOINTS;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postForm(
  fetchImpl: typeof fetch,
  endpoint: string,
  body: Record<string, string>,
): Promise<Response> {
  const form = new URLSearchParams(body);
  return fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
  });
}

async function parseTokenResponse(res: Response): Promise<OAuthTokenResponse> {
  let json: RawTokenResponse;
  try {
    json = (await res.json()) as RawTokenResponse;
  } catch {
    if (!res.ok) {
      throw new OAuthClientError(`token endpoint returned HTTP ${res.status}`);
    }
    throw new OAuthClientError("token endpoint returned a non-JSON body");
  }
  if (!res.ok || json.error) {
    // `invalid_grant` on refresh means the refresh token was revoked/expired.
    const invalidGrant = json.error === "invalid_grant";
    const detail = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    throw new OAuthClientError(`token exchange failed: ${detail}`, invalidGrant);
  }
  if (!json.access_token) {
    throw new OAuthClientError("token response missing access_token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in,
    scope: json.scope,
    tokenType: json.token_type,
  };
}

export class OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoints: typeof CF_OAUTH_ENDPOINTS;

  constructor(opts: OAuthClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoints = opts.endpoints ?? CF_OAUTH_ENDPOINTS;
  }

  /** Exchange an authorization `code` (+ PKCE verifier) for tokens. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  }): Promise<OAuthTokenResponse> {
    const res = await postForm(this.fetchImpl, this.endpoints.token, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    return parseTokenResponse(res);
  }

  /**
   * Exchange a refresh token for a fresh access token (and possibly a rotated
   * refresh token). Throws `OAuthClientError { invalidGrant: true }` when the
   * refresh token is revoked — the lifecycle drops to "not connected".
   */
  async refresh(input: {
    refreshToken: string;
    clientId: string;
  }): Promise<OAuthTokenResponse> {
    const res = await postForm(this.fetchImpl, this.endpoints.token, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    });
    return parseTokenResponse(res);
  }

  /**
   * Revoke a refresh token on disconnect. Best-effort: a non-2xx is swallowed
   * (the local record is forgotten regardless), but a network throw propagates
   * so the caller can log it.
   */
  async revoke(input: {
    token: string;
    clientId: string;
  }): Promise<void> {
    await postForm(this.fetchImpl, this.endpoints.revoke, {
      token: input.token,
      client_id: input.clientId,
    });
  }
}

/**
 * Rotation rule (RFC 6749 §6): keep the newly-issued refresh token when the
 * response carries one, otherwise keep the previous token. Returns the refresh
 * token to persist after an exchange.
 */
export function applyRefreshRotation(
  previous: string,
  response: OAuthTokenResponse,
): string {
  return response.refreshToken ?? previous;
}

/**
 * Whether the granted scope string includes the write scope, i.e. the owner
 * consented to programmatic redeploy/undeploy. A read-only owner declines it.
 */
export function grantedWrite(scope: string | undefined, writeScope: string): boolean {
  if (!scope) return false;
  return scope.split(/\s+/).includes(writeScope);
}
