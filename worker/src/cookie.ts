/**
 * Cookie helpers.
 *
 * Kept tiny and dependency-free — no need for the `cookie` npm package in a
 * Worker. `parseCookieHeader` is duplicate-tolerant (later value wins, per
 * RFC 6265 §5.4 client behaviour).
 */

export function parseCookieHeader(
  header: string | null | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0) continue;
    const value = part.slice(eq + 1).trim();
    out.set(name, decodeURIComponent(value));
  }
  return out;
}

export interface SessionCookieOptions {
  /** Set the `Secure` attribute. Must be false only under `http://` dev. */
  secure: boolean;
  /** Cookie `Path`. Defaults to `/`. */
  path?: string;
  /** Optional `Max-Age` in seconds. Omit for a session cookie. */
  maxAgeSeconds?: number;
}

export function serializeSessionCookie(
  name: string,
  value: string,
  opts: SessionCookieOptions,
): string {
  const parts: string[] = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    `Path=${opts.path ?? "/"}`,
  ];
  if (opts.secure) parts.push("Secure");
  if (opts.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

/** Clear a cookie by name (Max-Age=0). Used on scope failures / logout. */
export function expireSessionCookie(
  name: string,
  opts: Pick<SessionCookieOptions, "secure" | "path">,
): string {
  return serializeSessionCookie(name, "", { ...opts, maxAgeSeconds: 0 });
}
