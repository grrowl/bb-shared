import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
} from "./pkce";
import { CF_OAUTH_ENDPOINTS } from "./oauth-constants";

describe("generatePkce", () => {
  it("produces a base64url verifier and its S256 challenge", () => {
    const pkce = generatePkce();
    expect(pkce.method).toBe("S256");
    // 32 random bytes → 43 base64url chars, RFC 7636 charset.
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // challenge == BASE64URL(SHA256(verifier))
    const expected = createHash("sha256")
      .update(pkce.verifier)
      .digest()
      .toString("base64url");
    expect(pkce.challenge).toBe(expected);
  });

  it("is unique per call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });

  it("is deterministic under an injected RNG (for tests)", () => {
    const fixed = () => Buffer.alloc(32, 7);
    const a = generatePkce({ randomImpl: fixed });
    const b = generatePkce({ randomImpl: fixed });
    expect(a).toEqual(b);
  });
});

describe("generateState", () => {
  it("returns a base64url token, unique per call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizeUrl", () => {
  it("assembles the exact CF authorize query (S256, no client secret)", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizeEndpoint: CF_OAUTH_ENDPOINTS.authorize,
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:8977/oauth/callback",
        scopes: ["account:read", "workers:read", "workers_scripts:write"],
        state: "state-abc",
        codeChallenge: "chal-xyz",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://dash.cloudflare.com/oauth2/auth",
    );
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-123");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:8977/oauth/callback");
    expect(q.get("scope")).toBe(
      "account:read workers:read workers_scripts:write",
    );
    expect(q.get("state")).toBe("state-abc");
    expect(q.get("code_challenge")).toBe("chal-xyz");
    expect(q.get("code_challenge_method")).toBe("S256");
    // A public client sends NO secret in the authorize request.
    expect(q.has("client_secret")).toBe(false);
  });
});
