import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedTunnel } from "./shared-tunnel.js";

const tunnels: SharedTunnel[] = [];
afterEach(() => tunnels.splice(0).forEach((tunnel) => tunnel.stop()));

describe("relay handshake rejection", () => {
  it.each([409, 426])("treats HTTP %i as terminal incompatibility", async (status) => {
    let upgrades = 0;
    const server = createServer();
    server.on("upgrade", (_request, socket) => {
      upgrades++;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tunnel = new SharedTunnel({ workerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tunnelSecret: "pairing-secret", loopbackBaseUrl: "http://127.0.0.1:1", log: { warn: vi.fn() } });
    tunnels.push(tunnel);
    try {
      tunnel.start();
      await vi.waitFor(() => expect(tunnel.getStatus().state).toBe("incompatible"));
      expect(tunnel.getStatus().lastError).toContain(`HTTP ${status}`);
      expect(tunnel.getStatus().lastError).not.toContain("pairing-secret");
      expect(upgrades).toBe(1);
    } finally { tunnel.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
