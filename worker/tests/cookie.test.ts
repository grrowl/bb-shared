import { describe, expect, it } from "vitest";
import {
  expireSessionCookie,
  parseCookieHeader,
  serializeSessionCookie,
} from "../src/cookie.js";

describe("parseCookieHeader", () => {
  it("returns an empty map for null / undefined / empty", () => {
    expect(parseCookieHeader(null).size).toBe(0);
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader("").size).toBe(0);
  });

  it("parses a single cookie", () => {
    const m = parseCookieHeader("bb_shared_session=abc");
    expect(m.get("bb_shared_session")).toBe("abc");
  });

  it("parses multiple cookies with whitespace", () => {
    const m = parseCookieHeader("a=1;  b=2 ; c=three");
    expect(m.get("a")).toBe("1");
    expect(m.get("b")).toBe("2");
    expect(m.get("c")).toBe("three");
  });

  it("later value wins on duplicates", () => {
    const m = parseCookieHeader("x=first; x=second");
    expect(m.get("x")).toBe("second");
  });

  it("URL-decodes values", () => {
    const m = parseCookieHeader("v=hello%20world");
    expect(m.get("v")).toBe("hello world");
  });

  it("skips malformed pairs (no `=`)", () => {
    const m = parseCookieHeader("valid=1; broken; also=2");
    expect(m.get("valid")).toBe("1");
    expect(m.get("also")).toBe("2");
    expect(m.size).toBe(2);
  });
});

describe("serializeSessionCookie", () => {
  it("includes HttpOnly, SameSite=Lax, and Path=/ by default", () => {
    const s = serializeSessionCookie("bb_shared_session", "abc", {
      secure: true,
    });
    expect(s).toContain("bb_shared_session=abc");
    expect(s).toContain("HttpOnly");
    expect(s).toContain("SameSite=Lax");
    expect(s).toContain("Path=/");
    expect(s).toContain("Secure");
  });

  it("omits Secure when `secure: false` (dev over http)", () => {
    const s = serializeSessionCookie("bb_shared_session", "abc", {
      secure: false,
    });
    expect(s).not.toContain("Secure");
  });

  it("includes Max-Age when provided", () => {
    const s = serializeSessionCookie("bb_shared_session", "abc", {
      secure: true,
      maxAgeSeconds: 3600,
    });
    expect(s).toContain("Max-Age=3600");
  });

  it("URL-encodes the value", () => {
    const s = serializeSessionCookie("k", "hello world", { secure: true });
    expect(s.startsWith("k=hello%20world")).toBe(true);
  });
});

describe("expireSessionCookie", () => {
  it("emits Max-Age=0", () => {
    const s = expireSessionCookie("bb_shared_session", { secure: true });
    expect(s).toContain("Max-Age=0");
  });
});
