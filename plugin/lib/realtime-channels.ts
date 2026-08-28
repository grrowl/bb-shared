// Realtime channel names — a pure-string module, no runtime deps.
//
// Split out of `server.ts` (issue 18) so frontend consumers can import the
// channel names without esbuild following a value import into `server.ts` and
// its Node-only token store (`node:crypto`), which fatally errors the browser
// bundle. `server.ts` re-exports `REALTIME_CHANNELS` from here for backward
// compatibility, so existing backend importers keep working unchanged.
//
// The frontend subscribes with `useRealtime(...)` to refetch when state
// changes; the backend broadcasts from wherever the mutation happens
// (`bb.realtime.publish(...)`).

export const REALTIME_CHANNELS = {
  /** Any token mutation (mint/rename/delete/share add/remove/update). */
  tokensChanged: "tokens-changed",
  /** Worker deploy / health transitions. Payload: { url?, healthy }. */
  workerChanged: "worker-changed",
  /**
   * Cloudflare OAuth connection transitions (issue 28). Payload:
   * ConnectionStatus (redacted — account id + live hostname, never a token).
   */
  connectionChanged: "connection-changed",
} as const;
