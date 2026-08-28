// PKCE + authorize-URL construction (issue 28).
//
// Authorization Code with PKCE (RFC 7636), S256 only — Cloudflare requires S256
// for public clients (spike TASK 2; wrangler sends `code_challenge_method=S256`).
// Pure and dependency-light so it unit-tests without any network or browser.
import { createHash, randomBytes } from "node:crypto";

/** PKCE material for one authorization attempt. */
export interface PkcePair {
  /** High-entropy secret kept in memory; sent on the token exchange. */
  verifier: string;
  /** BASE64URL(SHA256(verifier)) — sent on the authorize request. */
  challenge: string;
  /** Always "S256" (Cloudflare rejects "plain" for public clients). */
  method: "S256";
}

/** base64url with no padding, per RFC 7636 §A. */
function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Generate a PKCE verifier/challenge pair. The verifier is 32 random bytes
 * (43 base64url chars — within RFC 7636's 43–128 range); the challenge is its
 * S256 digest. `randomImpl`/`hashImpl` are injectable for deterministic tests.
 */
export function generatePkce(opts?: {
  randomImpl?: (n: number) => Buffer;
  hashImpl?: (input: string) => Buffer;
}): PkcePair {
  const rand = opts?.randomImpl ?? ((n: number) => randomBytes(n));
  const hash =
    opts?.hashImpl ??
    ((input: string) => createHash("sha256").update(input).digest());
  const verifier = base64url(rand(32));
  const challenge = base64url(hash(verifier));
  return { verifier, challenge, method: "S256" };
}

/** A random opaque `state` value for CSRF protection on the callback. */
export function generateState(randomImpl?: (n: number) => Buffer): string {
  const rand = randomImpl ?? ((n: number) => randomBytes(n));
  return base64url(rand(32));
}

/** Parameters that go into the authorize URL query string. */
export interface AuthorizeUrlParams {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  /** Scopes joined with a space. `offline_access` is appended by CF, not here. */
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}

/**
 * Build the full authorize URL the owner's browser opens. Matches wrangler's
 * query assembly (spike TASK 2): `response_type=code`, `client_id`,
 * `redirect_uri`, `scope` (space-joined), `state`, `code_challenge`,
 * `code_challenge_method=S256`.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(params.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}
