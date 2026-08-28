// Device-tied key providers (issue 29).
//
// A `KeyProvider` hands back a stable 32-byte AES key bound to *this* device.
// The key is generated once on first use, kept in the OS secure store, and
// never written to the repo or into `bb.storage.kv`. Encrypting the persisted
// secret fields with it (see `../worker-lifecycle/worker-record.ts`) makes a
// copied `bb.db` useless off the machine that minted the key.
//
// PROVIDERS
//   - KeychainKeyProvider (primary, macOS): stores the key in the login
//     Keychain via the `security` CLI. The plugin runs inside the owner's bb
//     server process on their Mac, so the Keychain is the right home — it is
//     unlocked for the owner's session and inaccessible to a raw disk copy.
//   - FileKeyProvider (fallback, non-macOS): a 0600 file under the bb data
//     dir. WEAKER — it protects only against a copied *kv/db blob*, not a copy
//     of the whole data dir (the key sits beside the ciphertext). Documented as
//     such; present so the feature degrades rather than failing on Linux.
//   - InMemoryKeyProvider (tests): a fixed key, no I/O.
//
// The interface is deliberately tiny so a per-platform secure store (libsecret,
// Windows DPAPI, …) can slot in later without touching the record store.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { SECRET_KEY_BYTES } from "./envelope";

/** Minimal logger shape (matches bb.log; all optional at call sites). */
export interface KeyProviderLog {
  debug?(msg: string, meta?: unknown): void;
  info?(msg: string, meta?: unknown): void;
  warn?(msg: string, meta?: unknown): void;
  error?(msg: string, meta?: unknown): void;
}

/** Source of the device-tied 32-byte key. */
export interface KeyProvider {
  /** Human-readable provider kind, for logs/diagnostics. */
  readonly kind: string;
  /**
   * Return the device key, generating + persisting it on first use. Stable for
   * the life of the device. Rejects if the secure store is unreachable.
   */
  getKey(): Promise<Buffer>;
}

/** Default Keychain service + account names for the bb-shared device key. */
export const DEVICE_KEY_SERVICE = "bb-shared-device-key";
export const DEVICE_KEY_ACCOUNT = "bb-shared";

// ---------------------------------------------------------------------------
// In-memory (tests).
// ---------------------------------------------------------------------------

/** Fixed-key provider for tests. Never persists anything. */
export class InMemoryKeyProvider implements KeyProvider {
  readonly kind = "in-memory";
  private readonly key: Buffer;

  constructor(key?: Buffer) {
    if (key && key.length !== SECRET_KEY_BYTES) {
      throw new Error(`key must be ${SECRET_KEY_BYTES} bytes`);
    }
    this.key = key ?? randomBytes(SECRET_KEY_BYTES);
  }

  async getKey(): Promise<Buffer> {
    return this.key;
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain (primary).
// ---------------------------------------------------------------------------

/** Result of a `security` invocation. */
interface SecurityResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable `security` CLI runner (real impl shells out; tests fake it). */
export type SecurityRunner = (args: string[]) => SecurityResult;

const realSecurityRunner: SecurityRunner = (args) => {
  const r = spawnSync("security", args, { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

/** True when the `security` CLI is present (macOS). Used to gate provider + tests. */
export function isSecurityCliAvailable(
  run: SecurityRunner = realSecurityRunner,
): boolean {
  try {
    // `security help` exits 0 and needs no args/keychain access.
    return run(["help"]).status === 0;
  } catch {
    return false;
  }
}

/**
 * macOS Keychain-backed key. Reads the key with `find-generic-password -w`
 * (raw password to stdout); on first use generates 32 random bytes and stores
 * them base64 with `add-generic-password`. The Keychain item is scoped to a
 * fixed service+account so the same key is returned across restarts.
 */
export class KeychainKeyProvider implements KeyProvider {
  readonly kind = "macos-keychain";
  private readonly service: string;
  private readonly account: string;
  private readonly run: SecurityRunner;
  private cached: Buffer | null = null;

  constructor(opts: {
    service?: string;
    account?: string;
    run?: SecurityRunner;
  } = {}) {
    this.service = opts.service ?? DEVICE_KEY_SERVICE;
    this.account = opts.account ?? DEVICE_KEY_ACCOUNT;
    this.run = opts.run ?? realSecurityRunner;
  }

  async getKey(): Promise<Buffer> {
    if (this.cached) return this.cached;
    const existing = this.read();
    if (existing) {
      this.cached = existing;
      return existing;
    }
    const key = randomBytes(SECRET_KEY_BYTES);
    this.write(key);
    // Read back so a lost write surfaces immediately rather than at decrypt time.
    const confirmed = this.read();
    if (!confirmed || !confirmed.equals(key)) {
      throw new Error("keychain: wrote device key but could not read it back");
    }
    this.cached = confirmed;
    return confirmed;
  }

  private read(): Buffer | null {
    const r = this.run([
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
    ]);
    if (r.status !== 0) return null; // exit 44 = item not found
    const b64 = r.stdout.trim();
    if (!b64) return null;
    const key = Buffer.from(b64, "base64");
    if (key.length !== SECRET_KEY_BYTES) {
      throw new Error(
        `keychain: stored device key is ${key.length} bytes, expected ${SECRET_KEY_BYTES}`,
      );
    }
    return key;
  }

  private write(key: Buffer): void {
    const r = this.run([
      "add-generic-password",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
      key.toString("base64"),
      "-U", // update if it already exists (avoids a duplicate-item error)
    ]);
    if (r.status !== 0) {
      throw new Error(
        `keychain: failed to store device key (status ${String(r.status)}): ${r.stderr.trim()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// File fallback (non-macOS) — WEAKER.
// ---------------------------------------------------------------------------

/**
 * 0600-file key, for platforms without a wired-up secure store. Weaker than the
 * Keychain: the key sits beside the ciphertext under the bb data dir, so it
 * only defends against a copy of the *kv/db blob alone*, not a copy of the
 * whole data directory. Chosen minimally so the feature degrades gracefully.
 */
export class FileKeyProvider implements KeyProvider {
  readonly kind = "file-0600";
  private readonly path: string;
  private cached: Buffer | null = null;

  constructor(opts: { path: string }) {
    this.path = opts.path;
  }

  async getKey(): Promise<Buffer> {
    if (this.cached) return this.cached;
    const existing = this.read();
    if (existing) {
      this.cached = existing;
      return existing;
    }
    const key = randomBytes(SECRET_KEY_BYTES);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, key.toString("base64"), { mode: 0o600 });
    chmodSync(this.path, 0o600); // enforce mode even if the file pre-existed
    this.cached = key;
    return key;
  }

  private read(): Buffer | null {
    let b64: string;
    try {
      b64 = readFileSync(this.path, "utf8").trim();
    } catch {
      return null; // ENOENT on first use
    }
    if (!b64) return null;
    const key = Buffer.from(b64, "base64");
    if (key.length !== SECRET_KEY_BYTES) {
      throw new Error(
        `device key file ${this.path} is ${key.length} bytes, expected ${SECRET_KEY_BYTES}`,
      );
    }
    return key;
  }
}

// ---------------------------------------------------------------------------
// Platform-aware factory.
// ---------------------------------------------------------------------------

/**
 * Pick the strongest available provider for this platform:
 *   - darwin with a working `security` CLI → Keychain (primary).
 *   - everything else → 0600 file under `<dataDir>/plugins/<pluginId>/` (weaker).
 * `platform` defaults to `process.platform`; injectable for tests.
 *
 * `dataDir` may be a thunk: it is only resolved on the (non-darwin) fallback
 * path, so a bind-gated source like `bb.server.experimental_dataDir` is never
 * read on macOS or at plugin-load time.
 */
export function createDeviceKeyProvider(opts: {
  dataDir: string | (() => string);
  pluginId: string;
  platform?: NodeJS.Platform;
  run?: SecurityRunner;
  log?: KeyProviderLog;
}): KeyProvider {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin" && isSecurityCliAvailable(opts.run)) {
    opts.log?.info?.("bb-shared: device key via macOS Keychain");
    return new KeychainKeyProvider({ run: opts.run });
  }
  const dataDir =
    typeof opts.dataDir === "function" ? opts.dataDir() : opts.dataDir;
  const path = `${dataDir}/plugins/${opts.pluginId}/${DEVICE_KEY_SERVICE}`;
  opts.log?.warn?.(
    `bb-shared: no OS secure store on ${platform}; device key falls back to a 0600 file (weaker at-rest protection)`,
    { path },
  );
  return new FileKeyProvider({ path });
}
