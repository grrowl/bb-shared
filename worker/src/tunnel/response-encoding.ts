// Response-encoding rules for bodies the worker only ever relays, never
// produces. Ported from bb's `apps/connect/src/response-encoding.ts`.
//
// The tunnel client forwards the local bb server's response bytes verbatim,
// including `content-encoding: gzip` (or br/zstd) bodies — bb compresses its
// own HTML, API JSON, and precompressed assets. Every Response the worker
// rebuilds around those bytes must therefore tell workerd "this body is already
// encoded exactly as content-encoding says".
//
// workerd's default is `encodeBody: "automatic"`, which means the opposite: the
// runtime owns the encoding and assumes the body handed to the constructor is
// identity. Given gzip bytes plus a `content-encoding: gzip` header it drops the
// header and ships the compressed bytes labelled `text/html`, so the browser
// renders raw gzip. `encodeBody: "manual"` is the only way to hand workerd a
// pre-encoded body.
//
// `manual` is also correct for identity bodies (content-encoding absent =
// nothing to encode), so it applies to every relayed response — no need to
// branch on whether this particular bb response happened to be compressed.

/**
 * Build the visitor-facing Response for a response relayed from the local bb
 * server, preserving bb's own content-encoding instead of letting workerd
 * re-encode (and thereby corrupt) the body.
 *
 * `encodeBody` is a Cloudflare-only ResponseInit extension; on Node (the vitest
 * pool) it is an unknown field that undici ignores, so this stays testable.
 */
export function relayedResponse(
  body: BodyInit | null,
  status: number,
  headers: HeadersInit,
): Response {
  return new Response(body, { status, headers, encodeBody: "manual" });
}
