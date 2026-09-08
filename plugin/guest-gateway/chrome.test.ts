import { describe, expect, it } from "vitest";
import {
  insertShimIntoHtml,
  isHtmlResponse,
  shimForPerms,
  SHIM_HTML,
} from "./chrome";
import {
  buildShimHtml,
  CHROME_SELECTORS,
  GUEST_ROOT_ATTR,
  PERM_ROOT_ATTR,
  PERM_READ_FLAG,
} from "./chrome-selectors";
import type { ThreadPerm } from "./scope";

// These tests run under vitest's node environment, where the Workers-native
// `HTMLRewriter` global is absent — so `injectGuestChrome` exercises the
// string-insertion fallback. Both paths inject the identical `SHIM_HTML`
// block, so the observable contract asserted here holds on the edge too.

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

describe("SHIM_HTML", () => {
  it("sets the guest dataset flag", () => {
    expect(SHIM_HTML).toContain(`dataset.bbGuest="1"`);
  });

  it("scopes each selector under the right root and hides it", () => {
    for (const sel of CHROME_SELECTORS) {
      // Owner-only chrome is scoped under the bare guest root; read-only chrome
      // (the composer) is additionally scoped under the read-perm attribute so
      // it hides only on a read thread.
      const root = sel.readOnly
        ? `[${GUEST_ROOT_ATTR}][${PERM_ROOT_ATTR}="${PERM_READ_FLAG}"]`
        : `[${GUEST_ROOT_ATTR}]`;
      expect(SHIM_HTML).toContain(`${root} ${sel.css}`);
    }
    expect(SHIM_HTML).toContain("display: none !important");
  });

  it("scopes the composer hide only under the read-perm attribute", () => {
    // The composer selector must NOT be hidden for every guest — a write guest
    // keeps it. So the bare guest root must not directly hide `[data-app-composer]`.
    expect(SHIM_HTML).not.toContain(
      `[${GUEST_ROOT_ATTR}] [data-app-composer]`,
    );
    expect(SHIM_HTML).toContain(
      `[${GUEST_ROOT_ATTR}][${PERM_ROOT_ATTR}="${PERM_READ_FLAG}"] [data-app-composer]`,
    );
  });

  it("carries the selectors corrected against the audited bb build", () => {
    // Regression guard on the two divergences from issue 12's literal list.
    expect(SHIM_HTML).toContain(`[data-testid="plugin-nav-sidebar-items"]`);
    expect(SHIM_HTML).not.toContain(`.plugin-nav-sidebar-items`);
    expect(SHIM_HTML).toContain(`[aria-label^="Settings"]`);
  });

  it("carries a route-change watcher that re-evaluates the perm attribute", () => {
    // The composer hide is client-side re-evaluated on SPA navigation, so the
    // watcher must patch history and toggle the perm attribute by URL thread id.
    expect(SHIM_HTML).toContain("pushState");
    expect(SHIM_HTML).toContain("popstate");
    expect(SHIM_HTML).toContain(PERM_ROOT_ATTR);
    // The thread-id extractor greps the URL path (escaped slashes in the regex).
    expect(SHIM_HTML).toContain("threads");
  });

  it("base shim carries an empty read-thread set (hides no composer)", () => {
    expect(SHIM_HTML).toContain("new Set([])");
  });
});

// =========================================================================
// shimForPerms — per-request composer hide driven by ctx.perms
// =========================================================================

describe("shimForPerms", () => {
  const T_READ = "thr_read1";
  const T_WRITE = "thr_write1";

  it("returns the base shim for null / empty / write-only perms", () => {
    expect(shimForPerms(null)).toBe(SHIM_HTML);
    expect(shimForPerms([])).toBe(SHIM_HTML);
    // No read threads → nothing thread-specific to hide → identical bytes.
    expect(shimForPerms([{ threadId: T_WRITE, mode: "write" }])).toBe(SHIM_HTML);
  });

  it("embeds only the read-mode thread ids in the client script", () => {
    const perms: ThreadPerm[] = [
      { threadId: T_READ, mode: "read" },
      { threadId: T_WRITE, mode: "write" },
    ];
    const shim = shimForPerms(perms);
    // The read thread is in the injected set; the write thread is NOT — a write
    // guest keeps the composer, so its id need not (and does not) appear.
    expect(shim).toContain(`new Set(["${T_READ}"])`);
    expect(shim).not.toContain(T_WRITE);
    // Same style/CSS block as the base shim — only the script's set differs.
    expect(shim).toContain(
      `[${GUEST_ROOT_ATTR}][${PERM_ROOT_ATTR}="${PERM_READ_FLAG}"] [data-app-composer]`,
    );
  });

  it("escapes '<' in a thread id so a payload cannot break out of <script>", () => {
    const shim = buildShimHtml(undefined, ["thr_</script><x>"]);
    expect(shim).not.toContain("</script><x>");
    expect(shim).toContain("\\u003c");
  });
});

// =========================================================================
// injectGuestChrome — content-type gating
// =========================================================================

describe("isHtmlResponse", () => {
  const ct = (value: string | null) =>
    isHtmlResponse(
      new Response("", value === null ? {} : { headers: { "content-type": value } }),
    );

  it("matches text/html with and without a charset", () => {
    expect(ct("text/html")).toBe(true);
    expect(ct("text/html; charset=utf-8")).toBe(true);
    expect(ct("TEXT/HTML")).toBe(true);
  });

  it("rejects JSON / JS / CSS / missing", () => {
    expect(ct("application/json")).toBe(false);
    expect(ct("text/javascript")).toBe(false);
    expect(ct("application/javascript")).toBe(false);
    expect(ct("text/css")).toBe(false);
    expect(ct(null)).toBe(false);
    // No false-positive on a look-alike media type.
    expect(ct("text/htmlish")).toBe(false);
  });
});

// =========================================================================
// insertShimIntoHtml — malformed input degrades gracefully
// =========================================================================

describe("insertShimIntoHtml", () => {
  it("inserts after <head> when present", () => {
    const out = insertShimIntoHtml("<html><head></head></html>", "SHIM");
    expect(out).toBe("<html><head>\nSHIM</head></html>");
  });

  it("respects attributes on the head tag", () => {
    const out = insertShimIntoHtml(`<head data-x="1">`, "SHIM");
    expect(out).toBe(`<head data-x="1">\nSHIM`);
  });

  it("wraps a fresh head when only <html> is present", () => {
    const out = insertShimIntoHtml("<html><body>hi</body></html>", "SHIM");
    expect(out).toBe("<html>\n<head>SHIM</head><body>hi</body></html>");
  });

  it("prepends when there is no <head> or <html> (fragment)", () => {
    expect(insertShimIntoHtml("<body>hi</body>", "SHIM")).toBe(
      "SHIM\n<body>hi</body>",
    );
  });

  it("does not throw on empty or junk input", () => {
    expect(() => insertShimIntoHtml("", "SHIM")).not.toThrow();
    expect(() => insertShimIntoHtml("<<<not really html", "SHIM")).not.toThrow();
    expect(insertShimIntoHtml("", "SHIM")).toBe("SHIM\n");
  });
});

// =========================================================================
