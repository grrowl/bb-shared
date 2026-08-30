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
import type { ThreadPerm } from "../scope.js";

/**
 * The base block injected into `<head>` when the request carries no resolved
 * perms — computed once at module load, with an empty read-thread set (so it
 * hides owner chrome but no composer). Perm-bearing requests build a
 * per-request variant via {@link shimForPerms}.
 */
export const SHIM_HTML = buildShimHtml();

/**
 * Build the shim for a request's perms: the read-only thread ids drive the
 * client script's composer-hide. `null`/empty perms fall back to {@link
 * SHIM_HTML} (identical bytes to `buildShimHtml()` with no read threads).
 */
export function shimForPerms(perms: readonly ThreadPerm[] | null): string {
  if (perms === null || perms.length === 0) return SHIM_HTML;
  const readThreadIds = perms
    .filter((p) => p.mode === "read")
    .map((p) => p.threadId);
  if (readThreadIds.length === 0) return SHIM_HTML;
  return buildShimHtml(undefined, readThreadIds);
}

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

function injectViaHtmlRewriter(response: Response, shim: string): Response {
  return new HTMLRewriter()
    .on("head", {
      element(el) {
        el.append(shim, { html: true });
      },
    })
    .transform(response);
}

async function injectViaString(response: Response, shim: string): Promise<Response> {
  const rewritten = insertShimIntoHtml(await response.text(), shim);
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
 * equivalent buffered string rewrite. `shim` defaults to the perm-less base
 * block; the stage passes a per-request block built from `ctx.perms`.
 */
export async function injectGuestChrome(
  response: Response,
  shim: string = SHIM_HTML,
): Promise<Response> {
  if (!isHtmlResponse(response)) return response;
  if (typeof HTMLRewriter !== "undefined") {
    return injectViaHtmlRewriter(response, shim);
  }
  return injectViaString(response, shim);
}

/**
 * Wrap the terminal dispatch stage so guest HTML responses get the shim,
 * built from `ctx.perms` so the composer is hidden on the guest's read-only
 * threads (issue 36). Non-guest requests (no token — which the pipeline's
 * extract-token stage already rejects upstream, but guarded here too) and
 * non-HTML responses are passed through verbatim.
 */
export function chromeShimStage(inner: Stage): Stage {
  return {
    name: "chrome-shim",
    async run(ctx): Promise<StageResult> {
      const result = await inner.run(ctx);
      if (result.kind !== "respond") return result;
      if (ctx.token === null) return result;
      return respond(
        await injectGuestChrome(result.response, shimForPerms(ctx.perms)),
      );
    },
  };
}
