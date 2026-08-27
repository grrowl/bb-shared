import { describe, expect, it } from "vitest";
import {
  prepareOriginForTunnel,
  workerPublicOriginOf,
} from "../src/origin.js";

// These tests exercise the invariant from spike 02:
//
//   The request that leaves the worker on its way to the local tunnel client
//   MUST carry an Origin header that matches the tunnel's configured
//   `publicOrigin`. If we strip it, bb's browserRequestGuard 403s.
//
// Two acceptable strategies are: preserve unchanged, or unconditionally set
// to the worker's own public origin. We implement (b). These tests pin
// strategy (b).

const WORKER_ORIGIN = "https://guests-abc.workers.dev";

describe("workerPublicOriginOf", () => {
  it("returns the origin (scheme://host[:port]) with no path/query", () => {
    const request = new Request(
      "https://guests-abc.workers.dev/deep/path?q=1",
    );
    expect(workerPublicOriginOf(request)).toBe(WORKER_ORIGIN);
  });

  it("includes a non-default port", () => {
    const request = new Request("http://127.0.0.1:8787/x");
    expect(workerPublicOriginOf(request)).toBe("http://127.0.0.1:8787");
  });
});

describe("prepareOriginForTunnel", () => {
  it("sets Origin to the worker public origin when the guest sent no Origin", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x");
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.headers.get("origin")).toBe(WORKER_ORIGIN);
  });

  it("replaces a matching Origin with the same value (idempotent)", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x", {
      headers: { origin: WORKER_ORIGIN },
    });
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.headers.get("origin")).toBe(WORKER_ORIGIN);
  });

  it("overrides a stale/different guest Origin", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x", {
      headers: { origin: "https://old-worker.example.com" },
    });
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.headers.get("origin")).toBe(WORKER_ORIGIN);
  });

  it("never removes the Origin header (load-bearing per spike 02)", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x", {
      headers: { origin: "https://malicious.example.com" },
    });
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.headers.has("origin")).toBe(true);
  });

  it("preserves other headers", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x", {
      headers: {
        origin: "https://old.example.com",
        "user-agent": "smoke/1.0",
        "x-custom": "keep-me",
      },
    });
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.headers.get("user-agent")).toBe("smoke/1.0");
    expect(prepared.headers.get("x-custom")).toBe("keep-me");
    expect(prepared.headers.get("origin")).toBe(WORKER_ORIGIN);
  });

  it("preserves method + URL on the new Request", () => {
    const request = new Request("https://guests-abc.workers.dev/api/v1/x?q=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    const prepared = prepareOriginForTunnel(request, WORKER_ORIGIN);
    expect(prepared.method).toBe("POST");
    expect(prepared.url).toBe("https://guests-abc.workers.dev/api/v1/x?q=1");
  });
});
