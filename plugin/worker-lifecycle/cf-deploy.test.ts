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
    expect(redactSecrets("script name bb-shared")).toBe(
      "script name bb-shared",
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end pipeline over a faked CF REST (fetch is the only seam now — the
// upload is a raw multipart PUT, not the `cloudflare` SDK, per ticket 30 bug 3).
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FakeCfOptions {
  /** Override the script-upload PUT (default: succeeds with a deploymentId). */
  onUpload?: () => Promise<Response>;
  /** Records the enable-route POST body (bug 4). */
  onEnableRoute?: (body: unknown) => void;
  /** Status the propagated workers.dev URL serves (default 401 = live). */
  serveStatus?: number;
}

/** A fake CF REST + workers.dev origin driving the whole deploy pipeline. */
function fakeCf(opts: FakeCfOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (u.endsWith("/provisioning/previews/challenge")) {
      return jsonResponse({
        success: true,
        result: {
          challengeToken: "tok",
          seed: Buffer.alloc(32, 0).toString("base64url"),
          k: 1,
          g: 1,
        },
      });
    }
    if (u.endsWith("/provisioning/previews")) {
      return jsonResponse({
        success: true,
        result: {
          account: { id: "acct-1", apiToken: "cf-api-token", expiresAt: null },
          claim: { token: "ct", url: "https://claim.example/x", expiresAt: null },
        },
      });
    }
    // Script upload (raw multipart PUT).
    if (method === "PUT" && /\/workers\/scripts\/[^/]+$/.test(u)) {
      return opts.onUpload
        ? opts.onUpload()
        : jsonResponse({ success: true, result: { id: "dep-1" } });
    }
    // Account subdomain read.
    if (method === "GET" && u.endsWith("/workers/subdomain")) {
      return jsonResponse({ success: true, result: { subdomain: "sub" } });
    }
    // Per-script workers.dev route enable (bug 4).
    if (method === "POST" && /\/workers\/scripts\/[^/]+\/subdomain$/.test(u)) {
      opts.onEnableRoute?.(init?.body ? JSON.parse(String(init.body)) : undefined);
      return jsonResponse({ success: true, result: { enabled: true } });
    }
    // The workers.dev URL itself (route-propagation probe).
    if (u.startsWith("https://bb-shared.sub.workers.dev")) {
      return new Response("", { status: opts.serveStatus ?? 401 });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }) as unknown as typeof fetch;
}

const TUNNEL_SECRET = mintTunnelSecret();
const AUTHZ_TOKEN = "bbsh_" + "Z".repeat(40);

const input: DeployInput = {
  scriptName: "bb-shared",
  compatibilityDate: "2025-06-01",
  scriptContent: "export default {}",
  tunnelSecret: TUNNEL_SECRET,
  authzToken: AUTHZ_TOKEN,
  doClassName: "TunnelDO",
  doBindingName: "TUNNEL_DO",
  migrationTag: "v1",
};

describe("deployWorker pipeline", () => {
  it("uploads, enables the workers.dev route, and returns the live URL", async () => {
    let enableBody: unknown;
    const result = await deployWorker(input, {
      fetchImpl: fakeCf({ onEnableRoute: (b) => (enableBody = b) }),
      maxAttempts: 1,
      sleep: async () => {},
      propagationProbes: 3,
      propagationIntervalMs: 0,
    });

    expect(result.url).toBe("https://bb-shared.sub.workers.dev");
    expect(result.deploymentId).toBe("dep-1");
    expect(result.accountId).toBe("acct-1");
    // Bug 4: the per-script route MUST be enabled after upload.
    expect(enableBody).toEqual({ enabled: true, previews_enabled: false });
  });
});

describe("deployWorker secret redaction (M3, ticket 20)", () => {
  it("scrubs the secret from both the logged warning and the thrown error", async () => {
    // An upload failure whose CF error message echoes the request body (the
    // exact leak the review flagged) must be scrubbed on every path.
    const onUpload = async () =>
      jsonResponse(
        {
          success: false,
          errors: [
            {
              code: 400,
              message: `invalid binding TUNNEL_SECRET=${TUNNEL_SECRET} AUTHZ_TOKEN=${AUTHZ_TOKEN}`,
            },
          ],
        },
        400,
      );

    const warnings: string[] = [];
    let thrown: unknown;
    try {
      await deployWorker(input, {
        fetchImpl: fakeCf({ onUpload }),
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
