import { buildShimHtml } from "./chrome-selectors";
import type { ThreadPerm } from "./scope";
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

