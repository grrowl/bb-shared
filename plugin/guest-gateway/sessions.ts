import { randomBytes } from "node:crypto";
import { z } from "zod";
import { encryptRecord, decryptRecord, type KeyProvider } from "../lib/device-key";
import type { Store, Token, Share } from "../lib/token-store";
export interface RecordKv { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> }
const KEY = "guest-sessions-v1";
const TTL = 30 * 24 * 60 * 60 * 1000;
export const COOKIE = "__Host-bb-shared-session";
const schema = z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), grants: z.array(z.string()).max(128), expires: z.number().finite() })).max(2048);
type Session = z.infer<typeof schema>[number];
export class Sessions {
  private sessions = new Map<string, Session>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: Store, private kv: RecordKv, private keys: KeyProvider) {}
  async load() {
    const saved = await this.kv.get(KEY);
    if (saved === undefined || saved === null) return;
    const { record, migrated } = decryptRecord(saved, await this.keys.getKey(), ["payload"]);
    if (migrated) throw new Error("Unencrypted guest session state");
    const rows = schema.parse(JSON.parse((record as {payload:string}).payload));
    this.sessions = new Map(rows.filter(row => row.expires > Date.now()).map(row => [row.id, row]));
  }
  cookieId(cookie: string | undefined): string | undefined {
    const matches = (cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) return;
    const id = matches[0].slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : undefined;
  }
  async resolve(id: string | undefined): Promise<Token | null> {
    const session = id ? this.sessions.get(id) : undefined;
    if (!session || session.expires <= Date.now()) return null;
    const shares = new Map<string, Share>();
    for (const grant of session.grants) {
      const token = await this.store.getToken(grant);
      for (const share of token?.shares ?? []) {
        const prior = shares.get(share.thread_id);
        if (!prior || share.perm === "write") shares.set(share.thread_id, share);
      }
    }
    if (!shares.size) return null;
    return { id: session.id, hash: "", label: "Guest session", created_at: 0, shares: [...shares.values()] };
  }
  async redeem(raw: string, priorId?: string): Promise<string | null> {
    const operation = this.queue.then(async () => {
      const token = await this.store.findByRawToken(raw);
      if (!token || !token.shares.length) return null;
      const prior = priorId ? this.sessions.get(priorId) : undefined;
      const grants = prior && prior.expires > Date.now() ? prior.grants : [];
      const valid: string[] = [];
      for (const id of grants) if (await this.store.getToken(id)) valid.push(id);
      if (!valid.includes(token.id)) valid.push(token.id);
      if (valid.length > 128) throw new Error("Session invitation limit reached");
      // Preserve the opaque id for concurrent tabs; it is never accepted from URLs.
      const id = prior && prior.expires > Date.now() ? prior.id : randomBytes(32).toString("base64url");
      const next = new Map([...this.sessions].filter(([, row]) => row.expires > Date.now()));
      next.delete(id);
      next.set(id, { id, grants: valid, expires: Date.now() + TTL });
      // BB KV values are limited to 256 KiB. Leave room for AES envelope and
      // base64 expansion; evict oldest sessions before publishing a new one.
      while (next.size > 2048 || Buffer.byteLength(JSON.stringify([...next.values()])) > 160 * 1024) next.delete(next.keys().next().value!);
      await this.kv.set(KEY, encryptRecord({ payload: JSON.stringify([...next.values()]) }, await this.keys.getKey(), ["payload"]));
      this.sessions = next;
      return id;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async settled() { await this.queue; }
}
