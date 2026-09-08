import { z } from "zod";
import { decryptRecord, encryptRecord, type KeyProvider } from "../lib/device-key";

export interface RecordKv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Registration accepts a canonical HTTPS origin, never a redirect or a URL credential. */
export function normalizeConnectionUrl(value: string): string {
  const input = value.trim();
  const url = new URL(input.includes("://") ? input : `https://${input}`);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter an HTTPS hostname without a path, query, or username.");
  }
  return url.origin;
}

export const connectionRecordSchema = z.object({
  id: z.string().min(1),
  relayId: z.string().min(1).max(128),
  url: z.string().refine(value => { try { return normalizeConnectionUrl(value) === value; } catch { return false; } }),
  tunnelSecret: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  claim: z.object({ url: z.string().url(), expiresAt: z.number().nullable() }).nullable(),
  createdAt: z.number().finite(),
}).strict();
export type ConnectionRecord = z.infer<typeof connectionRecordSchema>;
const snapshotSchema = z.object({
  version: z.literal(1),
  defaultId: z.string().nullable(),
  connections: z.array(connectionRecordSchema).max(16),
}).strict().refine(s => new Set(s.connections.map(c => c.id)).size === s.connections.length
  && new Set(s.connections.map(c => c.relayId)).size === s.connections.length
  && new Set(s.connections.map(c => c.url)).size === s.connections.length
  && (s.defaultId === null ? s.connections.length === 0 : s.connections.some(c => c.id === s.defaultId)));
export type ConnectionSnapshot = z.infer<typeof snapshotSchema>;
export const CONNECTIONS_KEY = "connections-v1";

/** Entire connection snapshot is encrypted; no Cloudflare account credential is retained. */
export class ConnectionRecordStore {
  private unreadable = false;
  constructor(private readonly kv: RecordKv, private readonly keyProvider: KeyProvider) {}
  async load(): Promise<ConnectionSnapshot> {
    const raw = await this.kv.get<unknown>(CONNECTIONS_KEY);
    if (raw === undefined || raw === null) return { version: 1, defaultId: null, connections: [] };
    try {
      const decoded = decryptRecord(raw, await this.keyProvider.getKey(), ["payload"]).record as { payload: string };
      return snapshotSchema.parse(JSON.parse(decoded.payload));
    } catch {
      this.unreadable = true;
      throw new Error("Saved connections could not be decrypted. Restore the device key or connection storage before making changes.");
    }
  }
  async save(snapshot: ConnectionSnapshot): Promise<void> {
    if (this.unreadable) throw new Error("Saved connections need recovery before they can be changed.");
    const valid = snapshotSchema.parse(snapshot);
    await this.kv.set(CONNECTIONS_KEY, encryptRecord({ payload: JSON.stringify(valid) }, await this.keyProvider.getKey(), ["payload"]));
  }
}
