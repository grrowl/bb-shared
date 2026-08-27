import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Pure-function tests; no Workers pool needed. When we later add DO/edge
    // integration tests, split them out with @cloudflare/vitest-pool-workers.
    environment: "node",
  },
});
