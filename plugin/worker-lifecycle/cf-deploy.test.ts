// M3 (ticket 20): the CF deploy path must never let a tunnel secret / authz
// token reach a log sink. These tests cover the pure `redactSecrets` scrubber
// and the end-to-end guarantee: a synthetic SDK error whose message echoes the
// request body (including the raw `TUNNEL_SECRET`) is redacted both in the
// logged form AND in the error that propagates out of `deployWorker`.
import { describe, expect, it } from "vitest";
import { deployWorker, redactSecrets, type DeployInput } from "./cf-deploy";
import { mintTunnelSecret } from "./tunnel-secret";

describe("redactSecrets", () => {
  it("scrubs bbsh_ / bbcm_ prefixed credentials", () => {
    const out = redactSecrets("token=bbsh_abc123DEF-_ and pair=bbcm_XYZ789");
    expect(out).not.toContain("bbsh_abc123DEF-_");
    expect(out).not.toContain("bbcm_XYZ789");
    expect(out).toContain("[redacted]");
  });

  it("scrubs a 32+ char base64url run (the 43-char tunnel secret)", () => {
    const secret = mintTunnelSecret(); // 43-char base64url
    const out = redactSecrets(`CF rejected TUNNEL_SECRET=${secret} (invalid)`);
    expect(out).not.toContain(secret);
    expect(out).toContain("[redacted]");
  });

  it("leaves short, non-secret text intact", () => {
    expect(redactSecrets("HTTP 400 bad request")).toBe("HTTP 400 bad request");
    expect(redactSecrets("script name bb-shared-worker")).toBe(
      "script name bb-shared-worker",
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: an SDK error that echoes the secret must be scrubbed.
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fake CF REST for provisioning; the SDK upload is where the throw happens. */
function provisioningFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input.toString();
    if (u.endsWith("/provisioning/previews/challenge")) {
      return jsonResponse({
        success: true,
        result: {
          challengeToken: "tok",
          seed: Buffer.alloc(32, 0).toString("base64"),
          k: 1,
          g: 1,
        },
      });
    }
    if (u.endsWith("/provisioning/previews")) {
      return jsonResponse({
        success: true,
        result: {
          account: { id: "acct-1", apiToken: "cf-api-token" },
          claim: { token: "ct", url: "https://claim.example/x", expiresAt: null },
        },
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as unknown as typeof fetch;
}

const TUNNEL_SECRET = mintTunnelSecret();
const AUTHZ_TOKEN = "bbsh_" + "Z".repeat(40);

const input: DeployInput = {
  scriptName: "bb-shared-worker",
  compatibilityDate: "2025-06-01",
  scriptContent: "export default {}",
  tunnelSecret: TUNNEL_SECRET,
  authzToken: AUTHZ_TOKEN,
  doClassName: "TunnelDO",
  doBindingName: "TUNNEL_DO",
  migrationTag: "v1",
};

describe("deployWorker secret redaction (M3, ticket 20)", () => {
  it("scrubs the secret from both the logged warning and the thrown error", async () => {
    // A clientFactory whose scripts.update throws an error whose message echoes
    // the request body — the exact leak the review flagged.
    const clientFactory = () =>
      ({
        workers: {
          scripts: {
            update: async () => {
              throw new Error(
                `CF 400: invalid binding TUNNEL_SECRET=${TUNNEL_SECRET} AUTHZ_TOKEN=${AUTHZ_TOKEN}`,
              );
            },
          },
          subdomains: {
            get: async () => ({ subdomain: "sub" }),
          },
        },
      }) as never;

    const warnings: string[] = [];
    let thrown: unknown;
    try {
      await deployWorker(input, {
        fetchImpl: provisioningFetch(),
        clientFactory,
        maxAttempts: 1,
        sleep: async () => {},
        log: { warn: (m) => warnings.push(m) },
      });
    } catch (err) {
      thrown = err;
    }

    // It failed (as designed), and NOTHING logged contains the raw secret.
    expect(thrown).toBeInstanceOf(Error);
    expect(warnings.length).toBeGreaterThan(0);
    for (const line of warnings) {
      expect(line).not.toContain(TUNNEL_SECRET);
      expect(line).not.toContain(AUTHZ_TOKEN);
      expect(line).toContain("[redacted]");
    }

    // The propagated error is scrubbed too — so any downstream log of it (e.g.
    // worker-lifecycle's deploy catch) can't leak the secret either.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(TUNNEL_SECRET);
    expect(message).not.toContain(AUTHZ_TOKEN);
    expect(message).toContain("[redacted]");
  });
});
