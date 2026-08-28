import { describe, expect, it } from "vitest";
import {
  applyRefreshRotation,
  grantedWrite,
  OAuthClient,
  OAuthClientError,
  type OAuthTokenResponse,
} from "./oauth-client";
import { CF_OAUTH_ENDPOINTS, CF_SCOPES } from "./oauth-constants";

interface Captured {
  url: string;
  method: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

/** A fetch mock that records the request and returns a scripted response. */
function mockFetch(
  respond: (captured: Captured) => Response,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const body = Object.fromEntries(new URLSearchParams(bodyStr));
    const captured: Captured = {
      url,
      method: init?.method ?? "GET",
      body,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(captured);
    return respond(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OAuthClient.exchangeCode", () => {
  it("POSTs the auth-code grant with PKCE verifier and NO client secret", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        scope: "account:read workers:read",
        token_type: "bearer",
      }),
    );
    const client = new OAuthClient({ fetchImpl });
    const tokens = await client.exchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      clientId: "client-1",
      redirectUri: "http://127.0.0.1:8977/oauth/callback",
    });

    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.expiresInSeconds).toBe(3600);

    expect(calls[0].url).toBe(CF_OAUTH_ENDPOINTS.token);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://127.0.0.1:8977/oauth/callback",
      client_id: "client-1",
      code_verifier: "verifier-1",
    });
    expect("client_secret" in calls[0].body).toBe(false);
  });

  it("throws on an error body", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ error: "invalid_request" }, 400),
    );
    const client = new OAuthClient({ fetchImpl });
    await expect(
      client.exchangeCode({
        code: "x",
        codeVerifier: "y",
        clientId: "c",
        redirectUri: "r",
      }),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });
});

describe("OAuthClient.refresh", () => {
  it("POSTs the refresh grant and returns a rotated refresh token", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        access_token: "at-2",
        refresh_token: "rt-2", // rotated
        expires_in: 3600,
      }),
    );
    const client = new OAuthClient({ fetchImpl });
    const tokens = await client.refresh({
      refreshToken: "rt-1",
      clientId: "client-1",
    });
    expect(tokens.accessToken).toBe("at-2");
    expect(tokens.refreshToken).toBe("rt-2");
    expect(calls[0].body).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-1",
      client_id: "client-1",
    });
  });

  it("flags invalidGrant when the refresh token is revoked", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ error: "invalid_grant" }, 400),
    );
    const client = new OAuthClient({ fetchImpl });
    await expect(
      client.refresh({ refreshToken: "dead", clientId: "c" }),
    ).rejects.toMatchObject({ invalidGrant: true });
  });
});

describe("OAuthClient.revoke", () => {
  it("POSTs the token to the revoke endpoint", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response("", { status: 200 }));
    const client = new OAuthClient({ fetchImpl });
    await client.revoke({ token: "rt-1", clientId: "client-1" });
    expect(calls[0].url).toBe(CF_OAUTH_ENDPOINTS.revoke);
    expect(calls[0].body).toEqual({ token: "rt-1", client_id: "client-1" });
  });
});

describe("applyRefreshRotation (RFC 6749 §6)", () => {
  it("keeps the new refresh token when the response includes one", () => {
    const resp: OAuthTokenResponse = { accessToken: "a", refreshToken: "new" };
    expect(applyRefreshRotation("old", resp)).toBe("new");
  });
  it("keeps the previous token when the response omits it", () => {
    const resp: OAuthTokenResponse = { accessToken: "a" };
    expect(applyRefreshRotation("old", resp)).toBe("old");
  });
});

describe("grantedWrite", () => {
  it("detects the write scope in the granted scope string", () => {
    expect(
      grantedWrite("account:read workers:read workers_scripts:write", CF_SCOPES.scriptsWrite),
    ).toBe(true);
  });
  it("is false for a read-only grant or missing scope", () => {
    expect(grantedWrite("account:read workers:read", CF_SCOPES.scriptsWrite)).toBe(
      false,
    );
    expect(grantedWrite(undefined, CF_SCOPES.scriptsWrite)).toBe(false);
  });
});
