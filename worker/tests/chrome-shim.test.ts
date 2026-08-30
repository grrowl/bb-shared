import { describe, expect, it } from "vitest";
import {
  chromeShimStage,
  injectGuestChrome,
  insertShimIntoHtml,
  isHtmlResponse,
  shimForPerms,
  SHIM_HTML,
} from "../src/stages/chrome-shim.js";
import {
  buildShimHtml,
  CHROME_SELECTORS,
  GUEST_ROOT_ATTR,
  PERM_ROOT_ATTR,
  PERM_READ_FLAG,
} from "../src/chrome-selectors.js";
import { respond, type RequestContext, type Stage } from "../src/pipeline.js";
import type { ThreadPerm } from "../src/scope.js";

// These tests run under vitest's node environment, where the Workers-native
// `HTMLRewriter` global is absent — so `injectGuestChrome` exercises the
// string-insertion fallback. Both paths inject the identical `SHIM_HTML`
// block, so the observable contract asserted here holds on the edge too.

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

// A minimal RequestContext — the chrome-shim stage reads `ctx.token` and
// `ctx.perms`. Perms default to null (base shim, no composer hide).
const ctxWith = (
  token: string | null,
  perms: readonly ThreadPerm[] | null = null,
): RequestContext =>
  ({ token, perms }) as unknown as RequestContext;

const staticStage = (response: Response): Stage => ({
  name: "inner",
  run: () => respond(response),
});

// =========================================================================
// The shim block itself
// =========================================================================

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

describe("injectGuestChrome", () => {
  it("injects the shim into an HTML response inside <head>", async () => {
    const out = await injectGuestChrome(
      html("<!doctype html><html><head><title>bb</title></head><body></body></html>"),
    );
    const text = await out.text();
    expect(text).toContain(SHIM_HTML);
    // Injected after the opening <head>, i.e. before the app's own head content.
    expect(text.indexOf(SHIM_HTML)).toBeLessThan(text.indexOf("<title>"));
    expect(out.headers.get("content-type")).toContain("text/html");
  });

  it("leaves a JSON response byte-for-byte unchanged", async () => {
    const body = JSON.stringify({ projects: [], threads: [] });
    const out = await injectGuestChrome(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    expect(await out.text()).toBe(body);
  });

  it("leaves a JS response unchanged", async () => {
    const body = `export const x = "<head>not html</head>";`;
    const out = await injectGuestChrome(
      new Response(body, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      }),
    );
    const text = await out.text();
    expect(text).toBe(body);
    expect(text).not.toContain(SHIM_HTML);
  });

  it("leaves a CSS response unchanged", async () => {
    const body = `head { color: red; }`;
    const out = await injectGuestChrome(
      new Response(body, { headers: { "content-type": "text/css" } }),
    );
    expect(await out.text()).toBe(body);
  });

  it("preserves the response status", async () => {
    const out = await injectGuestChrome(
      html("<html><head></head></html>", { status: 200 }),
    );
    expect(out.status).toBe(200);
  });
});

// =========================================================================
// isHtmlResponse
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
// chromeShimStage — decorator behavior
// =========================================================================

describe("chromeShimStage", () => {
  it("injects the shim for a guest (token present) HTML response", async () => {
    const inner = staticStage(html("<html><head></head></html>"));
    const result = await chromeShimStage(inner).run(ctxWith("bbsh_token"));
    expect(result.kind).toBe("respond");
    if (result.kind !== "respond") throw new Error("unreachable");
    expect(await result.response.text()).toContain(SHIM_HTML);
  });

  it("injects the read thread's id when the guest has a read perm", async () => {
    const inner = staticStage(html("<html><head></head></html>"));
    const result = await chromeShimStage(inner).run(
      ctxWith("bbsh_token", [
        { threadId: "thr_readA", mode: "read" },
        { threadId: "thr_writeB", mode: "write" },
      ]),
    );
    if (result.kind !== "respond") throw new Error("unreachable");
    const text = await result.response.text();
    expect(text).toContain(`new Set(["thr_readA"])`);
    expect(text).not.toContain("thr_writeB");
  });

  it("leaves the response unchanged when there is no token (non-guest)", async () => {
    const original = "<html><head></head></html>";
    const inner = staticStage(html(original));
    const result = await chromeShimStage(inner).run(ctxWith(null));
    if (result.kind !== "respond") throw new Error("unreachable");
    expect(await result.response.text()).toBe(original);
  });

  it("leaves a guest JSON response unchanged", async () => {
    const body = `{"ok":true}`;
    const inner = staticStage(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const result = await chromeShimStage(inner).run(ctxWith("bbsh_token"));
    if (result.kind !== "respond") throw new Error("unreachable");
    expect(await result.response.text()).toBe(body);
  });

  it("passes a non-respond inner result through untouched", async () => {
    const passthroughCtx = ctxWith("bbsh_token");
    const inner: Stage = {
      name: "inner",
      run: () => ({ kind: "continue", ctx: passthroughCtx }),
    };
    const result = await chromeShimStage(inner).run(passthroughCtx);
    expect(result.kind).toBe("continue");
  });
});
