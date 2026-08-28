import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The worker lives outside the npm workspace, so the vendored tunnel contract
  // is reached by path. Mirror the tsconfig `paths` entry here so vitest can
  // resolve `@bb-shared/tunnel-contract` when it loads the tunnel DO + tests.
  resolve: {
    alias: {
      "@bb-shared/tunnel-contract": fileURLToPath(
        new URL(
          "../packages/bb-shared-tunnel-contract/src/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Pure-function + mocked-socket tests; no Workers pool needed. When we later
    // add live DO/edge integration tests, split them out with
    // @cloudflare/vitest-pool-workers.
    environment: "node",
  },
});
