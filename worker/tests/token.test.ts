import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  buildCleanRedirectPath,
  extractToken,
  isValidToken,
} from "../src/token.js";
import { parseCookieHeader } from "../src/cookie.js";

// A canonical, valid token used across cases. 32 base64url chars after prefix.
const TOKEN_A = "bbsh_" + "A".repeat(32);
const TOKEN_B = "bbsh_" + "B".repeat(32);
// Contains the full base64url alphabet + hyphens/underscores.
// Full base64url alphabet mixture; length = 32.
const TOKEN_MIXED = "bbsh_abcXYZ0123456789-_ABCDEFGHIJKLMNOP";

describe("isValidToken", () => {
  it.each([TOKEN_A, TOKEN_B, TOKEN_MIXED])("accepts %s", (t) => {
    expect(isValidToken(t)).toBe(true);
  });
  it.each([
    null,
    undefined,
    "",
    "bbsh_",
    "bbsh_short",
    "bbsh_" + "A".repeat(31), // one under minimum
    "bbsh_" + "A".repeat(65), // one over maximum
    "bbsh_" + "A".repeat(32) + "!", // invalid char
    "BBSH_" + "A".repeat(32), // wrong prefix case
    "not_a_token_at_all",
    "  " + TOKEN_A + "  ", // whitespace
  ])("rejects %j", (t) => {
    expect(isValidToken(t)).toBe(false);
  });
});

describe("extractToken", () => {
  const emptyCookies = new Map<string, string>();

  it("returns null when the URL and cookies carry nothing", () => {
    const url = new URL("https://guests.example.com/");
    expect(extractToken(url, emptyCookies)).toBeNull();
  });

  it("finds a token as the first path segment", () => {
    const url = new URL(
      `https://guests.example.com/${TOKEN_A}/projects/p1/threads/t1`,
    );
    expect(extractToken(url, emptyCookies)).toEqual({
      token: TOKEN_A,
      source: "path",
      pathAfterToken: "/projects/p1/threads/t1",
    });
  });

  it("finds a token at the root path (/{token})", () => {
    const url = new URL(`https://guests.example.com/${TOKEN_A}`);
    expect(extractToken(url, emptyCookies)).toEqual({
      token: TOKEN_A,
      source: "path",
      pathAfterToken: "/",
    });
  });

  it("normalises `/{token}/` to `pathAfterToken = /`", () => {
    const url = new URL(`https://guests.example.com/${TOKEN_A}/`);
    expect(extractToken(url, emptyCookies)?.pathAfterToken).toBe("/");
  });

  it("preserves nested paths after the token", () => {
    const url = new URL(
      `https://guests.example.com/${TOKEN_A}/api/v1/threads/t1/send`,
    );
    expect(extractToken(url, emptyCookies)?.pathAfterToken).toBe(
      "/api/v1/threads/t1/send",
    );
  });

  it("falls back to ?token= when the path is tokenless", () => {
    const url = new URL(
      `https://guests.example.com/projects/p1?token=${TOKEN_A}`,
    );
    expect(extractToken(url, emptyCookies)).toEqual({
      token: TOKEN_A,
      source: "query",
      pathAfterToken: "/projects/p1",
    });
  });

  it("falls back to cookie when both path and query are empty", () => {
    const url = new URL("https://guests.example.com/projects/p1");
    const cookies = new Map([[SESSION_COOKIE_NAME, TOKEN_A]]);
    expect(extractToken(url, cookies)).toEqual({
      token: TOKEN_A,
      source: "cookie",
      pathAfterToken: "/projects/p1",
    });
  });

  it("prefers path over query over cookie", () => {
    // Path wins over both query and cookie
    const url1 = new URL(
      `https://guests.example.com/${TOKEN_A}/x?token=${TOKEN_B}`,
    );
    const cookies = new Map([[SESSION_COOKIE_NAME, TOKEN_MIXED]]);
    expect(extractToken(url1, cookies)?.token).toBe(TOKEN_A);

    // Query wins over cookie
    const url2 = new URL(`https://guests.example.com/x?token=${TOKEN_B}`);
    expect(extractToken(url2, cookies)?.token).toBe(TOKEN_B);

    // Cookie only
    const url3 = new URL("https://guests.example.com/x");
    expect(extractToken(url3, cookies)?.token).toBe(TOKEN_MIXED);
  });

  it("ignores a malformed path token and falls through to query", () => {
    const url = new URL(
      `https://guests.example.com/bbsh_nope/rest?token=${TOKEN_A}`,
    );
    // "bbsh_nope" isn't a valid token — path segment 1 is "bbsh_nope", which
    // fails the regex; extractToken must then try the query.
    expect(extractToken(url, emptyCookies)).toEqual({
      token: TOKEN_A,
      source: "query",
      pathAfterToken: "/bbsh_nope/rest",
    });
  });

  it("ignores a malformed cookie value", () => {
    const url = new URL("https://guests.example.com/x");
    const cookies = new Map([[SESSION_COOKIE_NAME, "bbsh_not_valid"]]);
    expect(extractToken(url, cookies)).toBeNull();
  });
});

describe("parseCookieHeader → extractToken end-to-end", () => {
  it("parses a real cookie header shape", () => {
    const cookies = parseCookieHeader(
      `theme=dark; ${SESSION_COOKIE_NAME}=${TOKEN_A}; foo=bar`,
    );
    const url = new URL("https://guests.example.com/settings");
    expect(extractToken(url, cookies)?.token).toBe(TOKEN_A);
  });

  it("handles a missing cookie header safely", () => {
    const cookies = parseCookieHeader(null);
    const url = new URL("https://guests.example.com/settings");
    expect(extractToken(url, cookies)).toBeNull();
  });
});

describe("buildCleanRedirectPath", () => {
  // The token is dropped from the URL: the cookie set in the same 302 carries
  // it, and a CLEAN bb path lets bb's client router open the thread directly
  // (a /{token} prefix is an unknown route → SPA falls back to `/`).
  it("strips the token param and keeps a clean path", () => {
    const url = new URL(
      `https://guests.example.com/projects/p1?token=${TOKEN_A}&foo=bar`,
    );
    expect(buildCleanRedirectPath(url, TOKEN_A)).toBe("/projects/p1?foo=bar");
  });

  it("preserves fragment", () => {
    const url = new URL(
      `https://guests.example.com/projects/p1?token=${TOKEN_A}#h`,
    );
    expect(buildCleanRedirectPath(url, TOKEN_A)).toBe("/projects/p1#h");
  });

  it("handles the token as the only query param", () => {
    const url = new URL(
      `https://guests.example.com/projects/p1?token=${TOKEN_A}`,
    );
    expect(buildCleanRedirectPath(url, TOKEN_A)).toBe("/projects/p1");
  });

  it("keeps `/` for a root entry", () => {
    const url = new URL(`https://guests.example.com/?token=${TOKEN_A}`);
    expect(buildCleanRedirectPath(url, TOKEN_A)).toBe("/");
  });
});
