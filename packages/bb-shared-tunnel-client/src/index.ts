// VENDORED from bb `packages/tunnel-client/src/`.
//   upstream repo: bb (private) — packages/tunnel-client
//   upstream commit: 31a190d (2026-08-26), bb 0.40.0
// Copied verbatim except the `@bb/tunnel-contract` import specifier, rewritten
// to `@bb-shared/tunnel-contract` (our vendored copy). Sync manually on bb
// version bumps. See ../VENDORED.md.
export { headersForLoopbackRequest } from "./headers.js";
export { humanizeTransportError } from "./humanize.js";
export {
  DEFAULT_MAX_RECONNECT_DELAY_MS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  ReconnectBackoff,
  type ReconnectBackoffOptions,
} from "./reconnect.js";
export {
  isBareBbRealtimeWs,
  requestOriginHttp,
  TunnelSession,
  type StreamOriginResult,
} from "./session.js";
