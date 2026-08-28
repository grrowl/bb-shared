import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { waitForOAuthCallback, LoopbackError } from "./loopback-server";
import { beginConnect } from "./connect-flow";
import { OAuthClient } from "./oauth-client";
import { OAUTH_CALLBACK_PATH } from "./oauth-constants";

/** Grab an ephemeral free port, then release it for the listener under test. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the loopback callback URL until it answers (server may still be binding). */
async function hitCallback(port: number, query: string): Promise<void> {
  const url = `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}?${query}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error("callback never became reachable");
}

describe("waitForOAuthCallback", () => {
  it("resolves { code, state } from a matching callback", async () => {
    const port = await freePort();
    const wait = waitForOAuthCallback({ port, expectedState: "st-1" });
    await hitCallback(port, "code=abc&state=st-1");
    await expect(wait).resolves.toEqual({ code: "abc", state: "st-1" });
  });

  it("rejects on a state mismatch (CSRF guard)", async () => {
    const port = await freePort();
    const wait = waitForOAuthCallback({ port, expectedState: "st-1" });
    // Attach the rejection handler BEFORE the callback fires so the rejection
    // is never momentarily unhandled.
    const assertion = expect(wait).rejects.toBeInstanceOf(LoopbackError);
    await hitCallback(port, "code=abc&state=WRONG");
    await assertion;
  });

  it("rejects on a provider error param", async () => {
    const port = await freePort();
    const wait = waitForOAuthCallback({ port, expectedState: "st-1" });
    const assertion = expect(wait).rejects.toBeInstanceOf(LoopbackError);
    await hitCallback(port, "error=access_denied");
    await assertion;
  });

  it("rejects when the abort signal fires", async () => {
    const port = await freePort();
    const ac = new AbortController();
    const wait = waitForOAuthCallback({
      port,
      expectedState: "st-1",
      signal: ac.signal,
    });
    ac.abort();
    await expect(wait).rejects.toBeInstanceOf(LoopbackError);
  });
});

describe("beginConnect", () => {
  it("builds an authorize URL and completes the code exchange on callback", async () => {
    const port = await freePort();
    const client = new OAuthClient({
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
            scope: "account:read workers:read workers_scripts:write",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    const pending = beginConnect({
      clientId: "client-xyz",
      port,
      client,
      pkce: { verifier: "v", challenge: "c", method: "S256" },
      state: "st-xyz",
    });

    const authUrl = new URL(pending.authorizeUrl);
    expect(authUrl.searchParams.get("client_id")).toBe("client-xyz");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${port}/oauth/callback`,
    );
    expect(authUrl.searchParams.get("state")).toBe("st-xyz");
    expect(authUrl.searchParams.get("code_challenge")).toBe("c");

    const done = pending.complete();
    await hitCallback(port, "code=the-code&state=st-xyz");
    const tokens = await done;
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");
  });

  it("throws when the client id is empty", () => {
    expect(() => beginConnect({ clientId: "", port: 1 })).toThrow(/client id/i);
  });
});
