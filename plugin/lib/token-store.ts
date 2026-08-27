// bb-shared token store (issue 05).
//
// In-memory only in v0. The `Store` interface exposes async methods so a
// persistent backend (SQLite, etc.) can slot in later without touching call
// sites. See SPEC.md §"Data model (in-memory only)".
//
// Security note (per ticket 05, refining SPEC.md):
// - The raw token is generated once, returned to the caller as `rawToken`, and
//   then discarded. Nothing in the store persists it.
// - `Token.hash = HMAC-SHA256(rawToken)` (base64url) is what the store keeps
//   as the comparison key; the HMAC secret is per-process and regenerated on
//   every plugin start (guest URLs die on restart — consistent with the SPEC's
//   in-memory posture).
// - `Token.id` is a short non-secret public handle (`bbsh_<12>`) used to
//   reference tokens in RPC methods (rename, delete, addShare, ...). This
//   trades off exactly matching SPEC's "id: bbsh_ + 32B base64url" byte-count
//   for the ticket's "raw token never persisted" invariant — the SPEC's field
//   name and prefix are preserved.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Data model — mirrors the zod schemas exported from `../server.ts` so the
// store's TS surface is the single source of truth for the runtime shape.
// ---------------------------------------------------------------------------

export type Perm = "read" | "write";

export interface Share {
  thread_id: string;
  project_id: string;
  perm: Perm;
  added_at: number;
}

export interface Token {
  id: string;
  hash: string;
  label: string;
  shares: Share[];
  created_at: number;
}

export interface MintResult {
  /** The stored token record. Safe to return over RPC. */
  token: Token;
  /** The raw bearer token — returned ONCE, never persisted. */
  rawToken: string;
}

export interface AddShareInput {
  thread_id: string;
  project_id: string;
  perm: Perm;
}

// ---------------------------------------------------------------------------
// Error taxonomy. RPC handlers map these to friendly messages; other callers
// can `instanceof`-check.
// ---------------------------------------------------------------------------

export class TokenNotFoundError extends Error {
  readonly code = "token_not_found";
  constructor(readonly token_id: string) {
    super(`token not found: ${token_id}`);
    this.name = "TokenNotFoundError";
  }
}

export class ShareNotFoundError extends Error {
  readonly code = "share_not_found";
  constructor(readonly token_id: string, readonly thread_id: string) {
    super(`share not found: token=${token_id} thread=${thread_id}`);
    this.name = "ShareNotFoundError";
  }
}

export class DuplicateShareError extends Error {
  readonly code = "duplicate_share";
  constructor(readonly token_id: string, readonly thread_id: string) {
    super(`share already exists: token=${token_id} thread=${thread_id}`);
    this.name = "DuplicateShareError";
  }
}

// ---------------------------------------------------------------------------
// Store interface. All methods are async — an on-disk backend can drop in
// without changing call sites.
// ---------------------------------------------------------------------------

export interface Store {
  mintToken(opts?: { label?: string; nowMs?: number }): Promise<MintResult>;
  listTokens(): Promise<Token[]>;
  getToken(id: string): Promise<Token | null>;
  /** Look up a token by its raw bearer value. For the authz endpoint (issue 06). */
  findByRawToken(rawToken: string): Promise<Token | null>;
  renameToken(id: string, label: string): Promise<void>;
  deleteToken(id: string): Promise<void>;
  addShare(token_id: string, share: AddShareInput, nowMs?: number): Promise<void>;
  removeShare(token_id: string, thread_id: string): Promise<void>;
  updateShare(token_id: string, thread_id: string, perm: Perm): Promise<void>;
}

// ---------------------------------------------------------------------------
// Token id + raw token generation.
// ---------------------------------------------------------------------------

const RAW_TOKEN_PREFIX = "bbsh_";
const TOKEN_ID_PREFIX = "bbsh_";
const RAW_TOKEN_BYTES = 32;
const TOKEN_ID_BYTES = 9; // 12 base64url chars after prefix

function base64url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateRawToken(): string {
  return RAW_TOKEN_PREFIX + base64url(randomBytes(RAW_TOKEN_BYTES));
}

export function generateTokenId(): string {
  return TOKEN_ID_PREFIX + base64url(randomBytes(TOKEN_ID_BYTES));
}

export function hashToken(hmacKey: Buffer, rawToken: string): string {
  return base64url(createHmac("sha256", hmacKey).update(rawToken).digest());
}

/** Constant-time hash comparison. */
function hashesEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Random verb-noun label generator.
// ---------------------------------------------------------------------------

// Small brand-neutral vocabs. Kept short deliberately — dedupe fills the space
// with numeric suffixes rather than requiring an exhaustive corpus.
const ADJECTIVES = [
  "brave", "silver", "gentle", "swift", "curious", "clever", "bright", "quiet",
  "sunny", "amber", "hazel", "cosy", "sturdy", "nimble", "eager", "merry",
  "keen", "warm", "olive", "azure", "ruby", "coral", "misty", "sleepy",
];

const ANIMALS = [
  "otter", "fox", "badger", "heron", "wren", "hare", "lynx", "owl",
  "seal", "mole", "stoat", "raven", "finch", "moth", "toad", "newt",
  "shrew", "sparrow", "beetle", "crow", "magpie", "gull", "kite", "vole",
];

export function randomLabel(rng: () => number = Math.random): string {
  const a = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)];
  const n = ANIMALS[Math.floor(rng() * ANIMALS.length)];
  return `${a}-${n}`;
}

/**
 * Pick a label that's not already in `taken`. Tries up to `maxAttempts` random
 * combinations, then falls back to `label-2`, `label-3`, ... until a free one
 * is found. Guaranteed to terminate — vocab is finite but the numeric suffix
 * range is unbounded.
 */
export function pickUniqueLabel(
  taken: ReadonlySet<string>,
  rng: () => number = Math.random,
  maxAttempts = 32,
): string {
  for (let i = 0; i < maxAttempts; i++) {
    const label = randomLabel(rng);
    if (!taken.has(label)) return label;
  }
  // Random space exhausted (or unlucky). Deterministic fallback.
  const base = randomLabel(rng);
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// InMemoryStore
// ---------------------------------------------------------------------------

export interface InMemoryStoreOptions {
  /**
   * HMAC key for hashing raw tokens. Per SPEC, per-process and in-memory only —
   * generated fresh at plugin start. Tests may inject a fixed key.
   */
  hmacKey?: Buffer;
  /** RNG override for label generation (deterministic tests). */
  rng?: () => number;
  /** Clock override (deterministic tests). Returns ms epoch. */
  now?: () => number;
}

export class InMemoryStore implements Store {
  private readonly hmacKey: Buffer;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly tokens = new Map<string, Token>();

  constructor(opts: InMemoryStoreOptions = {}) {
    this.hmacKey = opts.hmacKey ?? randomBytes(32);
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  async mintToken(opts: { label?: string; nowMs?: number } = {}): Promise<MintResult> {
    const takenLabels = new Set<string>();
    for (const t of this.tokens.values()) takenLabels.add(t.label);

    let label: string;
    if (opts.label !== undefined) {
      // Caller-specified labels bypass dedupe — the caller (RPC handler) is
      // free to policy-check separately. v0 keeps this permissive.
      label = opts.label;
    } else {
      label = pickUniqueLabel(takenLabels, this.rng);
    }

    const rawToken = generateRawToken();
    const hash = hashToken(this.hmacKey, rawToken);

    // Vanishingly unlikely id collision — regenerate rather than clobber.
    let id = generateTokenId();
    while (this.tokens.has(id)) id = generateTokenId();

    const token: Token = {
      id,
      hash,
      label,
      shares: [],
      created_at: opts.nowMs ?? this.now(),
    };
    this.tokens.set(id, cloneToken(token));

    return { token, rawToken };
  }

  async listTokens(): Promise<Token[]> {
    return Array.from(this.tokens.values(), cloneToken);
  }

  async getToken(id: string): Promise<Token | null> {
    const t = this.tokens.get(id);
    return t ? cloneToken(t) : null;
  }

  async findByRawToken(rawToken: string): Promise<Token | null> {
    const hash = hashToken(this.hmacKey, rawToken);
    for (const t of this.tokens.values()) {
      if (hashesEqual(t.hash, hash)) return cloneToken(t);
    }
    return null;
  }

  async renameToken(id: string, label: string): Promise<void> {
    const t = this.tokens.get(id);
    if (!t) throw new TokenNotFoundError(id);
    t.label = label;
  }

  async deleteToken(id: string): Promise<void> {
    if (!this.tokens.delete(id)) throw new TokenNotFoundError(id);
    // No dangling reference cleanup needed: shares live inside the token.
  }

  async addShare(
    token_id: string,
    share: AddShareInput,
    nowMs?: number,
  ): Promise<void> {
    const t = this.tokens.get(token_id);
    if (!t) throw new TokenNotFoundError(token_id);
    if (t.shares.some((s) => s.thread_id === share.thread_id)) {
      throw new DuplicateShareError(token_id, share.thread_id);
    }
    t.shares.push({
      thread_id: share.thread_id,
      project_id: share.project_id,
      perm: share.perm,
      added_at: nowMs ?? this.now(),
    });
  }

  async removeShare(token_id: string, thread_id: string): Promise<void> {
    const t = this.tokens.get(token_id);
    if (!t) throw new TokenNotFoundError(token_id);
    const idx = t.shares.findIndex((s) => s.thread_id === thread_id);
    if (idx === -1) throw new ShareNotFoundError(token_id, thread_id);
    t.shares.splice(idx, 1);
  }

  async updateShare(
    token_id: string,
    thread_id: string,
    perm: Perm,
  ): Promise<void> {
    const t = this.tokens.get(token_id);
    if (!t) throw new TokenNotFoundError(token_id);
    const share = t.shares.find((s) => s.thread_id === thread_id);
    if (!share) throw new ShareNotFoundError(token_id, thread_id);
    share.perm = perm;
  }
}

function cloneToken(t: Token): Token {
  return {
    id: t.id,
    hash: t.hash,
    label: t.label,
    created_at: t.created_at,
    shares: t.shares.map((s) => ({ ...s })),
  };
}

// ---------------------------------------------------------------------------
// URL builder — placeholder until issue 07 wires the worker URL through.
// ---------------------------------------------------------------------------

export interface BuildShareUrlOptions {
  /** Optional deep link to land the guest on a specific thread. */
  firstThread?: { project_id: string; thread_id: string };
  /**
   * Base URL of the deployed worker for this bb instance. If undefined, the
   * placeholder `https://<worker-pending>` is used and the caller (RPC
   * handler) leaves a TODO — issue 07 owns wiring the real URL.
   */
  workerOrigin?: string;
}

export function buildShareUrl(
  rawToken: string,
  opts: BuildShareUrlOptions = {},
): string {
  // TODO(issue 07): replace the placeholder origin with the live worker URL
  // once the worker deploy pipeline lands and can be surfaced via
  // `getWorkerStatus`.
  const origin = opts.workerOrigin ?? "https://<worker-pending>";
  if (opts.firstThread) {
    const { project_id, thread_id } = opts.firstThread;
    return `${origin}/${rawToken}/projects/${project_id}/threads/${thread_id}`;
  }
  return `${origin}/${rawToken}/`;
}
