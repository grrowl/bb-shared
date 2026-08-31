// Durable shared-link state. The entire payload is device-key encrypted:
// raw guest bearer tokens, labels, project ids, and thread ids never appear in
// bb.storage.kv as plaintext. The HMAC key is intentionally not persisted;
// InMemoryStore derives fresh hashes from the restored raw tokens on startup.
import { z } from "zod";
import {
  decryptRecord,
  encryptRecord,
  type KeyProvider,
} from "./device-key";
import type { TokenSnapshot } from "./token-store";

export const SHARE_STATE_KEY = "share-state";
const STATE_VERSION = 1;

interface RecordKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

interface RecordLog {
  warn(message: string): void;
}

const shareSchema = z.object({
  thread_id: z.string().min(1),
  project_id: z.string().min(1),
  perm: z.enum(["read", "write"]),
  added_at: z.number().finite(),
}).strict();

const stateSchema = z.object({
  version: z.literal(STATE_VERSION),
  tokens: z.array(z.object({
    id: z.string().regex(/^bbsh_[A-Za-z0-9_-]{12}$/),
    label: z.string().min(1).max(64),
    shares: z.array(shareSchema),
    created_at: z.number().finite(),
    rawToken: z.string().regex(/^bbsh_[A-Za-z0-9_-]{43}$/),
  }).strict()),
}).strict();

function validState(value: unknown): TokenSnapshot[] | null {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) return null;
  const ids = new Set<string>();
  for (const token of parsed.data.tokens) {
    if (ids.has(token.id)) return null;
    ids.add(token.id);
    if (token.shares.some((share, index, all) =>
      all.findIndex((candidate) => candidate.thread_id === share.thread_id) !== index,
    )) return null;
  }
  return parsed.data.tokens.map((token) => ({
    ...token,
    shares: token.shares.map((share) => ({ ...share })),
  }));
}

/**
 * Preserves an unreadable record rather than silently overwriting it with an
 * empty state. That keeps a recoverable device-key problem from becoming a
 * permanent revocation of every existing shared link.
 */
export class ShareStateRecordStore {
  private recoveryRequired = false;

  constructor(
    private readonly kv: RecordKv,
    private readonly keyProvider: KeyProvider,
    private readonly log?: RecordLog,
  ) {}

  async load(): Promise<TokenSnapshot[]> {
    this.recoveryRequired = false;
    const raw = await this.kv.get<unknown>(SHARE_STATE_KEY);
    if (raw === undefined || raw === null) return [];
    try {
      const decoded = decryptRecord(raw, await this.keyProvider.getKey(), ["payload"]);
      const record = decoded.record as { payload?: unknown };
      if (typeof record.payload !== "string") throw new Error("missing encrypted payload");
      const tokens = validState(JSON.parse(record.payload));
      if (tokens === null) throw new Error("invalid share state");
      if (decoded.migrated) await this.save(tokens);
      return tokens;
    } catch (error) {
      this.recoveryRequired = true;
      const reason = error instanceof Error ? error.message : String(error);
      this.log?.warn(`bb-shared: saved share state needs manual recovery (${reason})`);
      return [];
    }
  }

  async save(tokens: TokenSnapshot[]): Promise<void> {
    if (this.recoveryRequired) {
      throw new Error("Saved share state needs manual recovery before it can be changed.");
    }
    const validated = validState({ version: STATE_VERSION, tokens });
    if (validated === null) throw new Error("Refusing to save invalid shared link state.");
    const record = { version: STATE_VERSION, payload: JSON.stringify({ version: STATE_VERSION, tokens: validated }) };
    await this.kv.set(
      SHARE_STATE_KEY,
      encryptRecord(record, await this.keyProvider.getKey(), ["payload"]),
    );
  }
}
