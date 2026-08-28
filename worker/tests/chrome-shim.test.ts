import { describe, expect, it } from "vitest";
import {
  chromeShimStage,
  injectGuestChrome,
  insertShimIntoHtml,
  isHtmlResponse,
  SHIM_HTML,
} from "../src/stages/chrome-shim.js";
import {
  CHROME_SELECTORS,
  GUEST_ROOT_ATTR,
} from "../src/chrome-selectors.js";
import { respond, type RequestContext, type Stage } from "../src/pipeline.js";

// These tests run under vitest's node environment, where the Workers-native
// `HTMLRewriter` global is absent — so `injectGuestChrome` exercises the
// string-insertion fallback. Both paths inject the identical `SHIM_HTML`
// block, so the observable contract asserted here holds on the edge too.

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });

// A minimal RequestContext — the chrome-shim stage only reads `ctx.token`.
const ctxWith = (token: string | null): RequestContext =>
  ({ token }) as unknown as RequestContext;

const staticStage = (response: Response): Stage => ({
  name: "inner",
  run: () => respond(response),
});

// =========================================================================
// The shim block itself
// =========================================================================

describe("SHIM_HTML", () => {
  it("sets the guest dataset flag", () => {
    expect(SHIM_HTML).toContain(
      `document.documentElement.dataset.bbGuest = "1"`,
    );
  });

  it("scopes every selector under the guest root and hides it", () => {
    for (const sel of CHROME_SELECTORS) {
      expect(SHIM_HTML).toContain(`[${GUEST_ROOT_ATTR}] ${sel.css}`);
    }
    expect(SHIM_HTML).toContain("display: none !important");
  });

  it("carries the selectors corrected against the audited bb build", () => {
    // Regression guard on the two divergences from issue 12's literal list.
    expect(SHIM_HTML).toContain(`[data-testid="plugin-nav-sidebar-items"]`);
    expect(SHIM_HTML).not.toContain(`.plugin-nav-sidebar-items`);
    expect(SHIM_HTML).toContain(`[aria-label^="Settings"]`);
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
