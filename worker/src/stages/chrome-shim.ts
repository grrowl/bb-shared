/**
 * Stage 12: SPA chrome shim.
 *
 * For guest requests, rewrite `text/html` responses on the way out to inject a
 * small `<script>` + `<style>` into `<head>` that flags the document as a
 * guest session and hides owner-only chrome (see `../chrome-selectors.ts`).
 * JSON / JS / CSS and every non-guest response pass through untouched.
 *
 * This stage is a DECORATOR around the terminal dispatch stage rather than a
 * standalone entry in the pipeline array: `dispatchStage` short-circuits with
 * a `respond` result, so a plain stage listed after it would never run. The
 * decorator invokes its inner stage, and — only when that produced a response
 * for a guest — transforms it. Wire it in `worker.ts` as
 * `chromeShimStage(dispatchStage(router))`.
 *
 * Injection uses the Workers-native streaming `HTMLRewriter` when present
 * (the real edge runtime) — it never buffers the whole document. In
 * environments without it (node: CI, vitest), it falls back to an equivalent
 * string insertion. Both paths inject the identical block, so the observable
 * contract is the same and the fallback is what the tests exercise.
 */

import { respond, type Stage, type StageResult } from "../pipeline.js";
import { buildShimHtml } from "../chrome-selectors.js";

/** The block injected into `<head>`; computed once at module load. */
export const SHIM_HTML = buildShimHtml();

/** True only for `text/html` responses (any charset); JS/CSS/JSON are false. */
export function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType !== null && /^text\/html\b/i.test(contentType);
}

/**
 * Insert the shim into an HTML string, degrading gracefully on malformed
 * input. Preference order: right after `<head …>` (runs before app boot),
 * else after `<html …>` (wrap in a fresh head), else prepend. Never throws.
 */
export function insertShimIntoHtml(html: string, shim: string = SHIM_HTML): string {
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${html.slice(0, at)}\n${shim}${html.slice(at)}`;
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}\n<head>${shim}</head>${html.slice(at)}`;
  }
  // No <head>, no <html> — malformed or a fragment. Prepend rather than drop.
  return `${shim}\n${html}`;
}

function injectViaHtmlRewriter(response: Response): Response {
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(SHIM_HTML, { html: true });
      },
    })
    .transform(response);
}

async function injectViaString(response: Response): Promise<Response> {
  const rewritten = insertShimIntoHtml(await response.text());
  const headers = new Headers(response.headers);
  // Body length changed; let the platform recompute it.
  headers.delete("content-length");
  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Inject the guest chrome shim into an HTML response. Non-HTML responses are
 * returned unchanged. Uses streaming `HTMLRewriter` where available, else an
 * equivalent buffered string rewrite.
 */
export async function injectGuestChrome(response: Response): Promise<Response> {
  if (!isHtmlResponse(response)) return response;
  if (typeof HTMLRewriter !== "undefined") {
    return injectViaHtmlRewriter(response);
  }
  return injectViaString(response);
}

/**
 * Wrap the terminal dispatch stage so guest HTML responses get the shim.
 * Non-guest requests (no token — which the pipeline's extract-token stage
 * already rejects upstream, but guarded here too) and non-HTML responses are
 * passed through verbatim.
 */
export function chromeShimStage(inner: Stage): Stage {
  return {
    name: "chrome-shim",
    async run(ctx): Promise<StageResult> {
      const result = await inner.run(ctx);
      if (result.kind !== "respond") return result;
      if (ctx.token === null) return result;
      return respond(await injectGuestChrome(result.response));
    },
  };
}
