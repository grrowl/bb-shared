import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: vi.fn(), useRealtime: vi.fn(), useBbNavigate: vi.fn() }));
import { ConnectionSummary, type ConnectionView } from "./connections";

const connection: ConnectionView = { id: "connection-1", url: "https://share.example.com", state: "ready", isDefault: true };

describe("connection readiness display", () => {
  it("shows the hostname and measured readiness", () => {
    const html = renderToStaticMarkup(<ConnectionSummary connection={connection} />);
    expect(html).toContain("share.example.com");
    expect(html).toContain("Ready");
    expect(html).toContain("Default");
  });
  it.each(["connecting", "offline", "incompatible"] as const)("does not advertise %s connections as ready", (state) => {
    const html = renderToStaticMarkup(<ConnectionSummary connection={{ ...connection, state, fault: "Guest gateway unavailable" }} />);
    expect(html).not.toContain("Ready");
    expect(html).toContain("Guest gateway unavailable");
  });
});
