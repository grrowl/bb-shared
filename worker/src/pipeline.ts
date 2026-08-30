/**
 * Request pipeline.
 *
 * Each guest request runs through an ordered list of stages. A stage either
 * short-circuits with a Response or returns the (possibly mutated) context
 * for the next stage. Later tickets slot in as new stages without editing
 * the entry file:
 *
 *   - 09: response filters (post-dispatch stage that wraps the response)
 *   - 10: mutation gate + route lockouts (pre-dispatch stage keyed on method/path)
 *   - 11: WS filter (wraps the dispatchWebSocket stage)
 *   - 12: SPA chrome shim (post-dispatch stage keyed on content-type=html)
 *
 * The intent is that `worker.ts` reads more like a wiring diagram than a
 * fetch handler, and each incremental ticket is a new file under `stages/`.
 */

import type { Env } from "./env.js";
import type { GuestScope, ThreadPerm } from "./scope.js";

export interface RequestContext {
  /**
   * Mutable per-stage: earlier stages may rewrite the Request (e.g. strip a
   * `/{token}` path prefix, set Origin) before it reaches the tunnel dispatch.
   */
  request: Request;
  /** Parsed once at the entry point; kept in sync when `request` is rewritten. */
  url: URL;
  env: Env;
  ctx: ExecutionContext;
  /**
   * The worker's own public origin, e.g. `https://guests-abc.workers.dev`.
   * Every guest request is served from a single origin; captured here for
   * downstream stages so they don't re-parse `request.url`.
   */
  workerPublicOrigin: string;
  /** Present after the token-extraction stage runs; null before. */
  token: string | null;
  /**
   * The token's resolved authorization scope. Populated by the authz stage
   * (issue 10) from the plugin's `/authz` response; null until then. The WS
   * frame filter (issue 11) and other scope-enforcing stages read this — a
   * null scope is treated as deny-everything.
   */
  scope: GuestScope | null;
  /**
   * The token's per-thread permissions, straight from 06's `/authz` `perms`
   * (populated by the authz stage alongside `scope`; null before it runs). The
   * chrome shim (issue 36) reads this to hide the composer on read-only threads.
   * It covers EVERY thread in the token's shares, not just the requested path,
   * so the client-side shim can resolve a thread's mode after an SPA route
   * change without a fresh document. Not a security boundary — the mutation
   * gate is; a null/unknown perm keeps the composer visible (safe default).
   */
  perms: readonly ThreadPerm[] | null;
}

export type StageResult =
  | { kind: "continue"; ctx: RequestContext }
  | { kind: "respond"; response: Response };

export interface Stage {
  name: string;
  run(ctx: RequestContext): Promise<StageResult> | StageResult;
}

export const cont = (ctx: RequestContext): StageResult => ({
  kind: "continue",
  ctx,
});

export const respond = (response: Response): StageResult => ({
  kind: "respond",
  response,
});

export async function runPipeline(
  stages: readonly Stage[],
  initial: RequestContext,
): Promise<Response> {
  let ctx = initial;
  for (const stage of stages) {
    const result = await stage.run(ctx);
    if (result.kind === "respond") return result.response;
    ctx = result.ctx;
  }
  // The final stage must always produce a Response; anything else is a
  // programming error, not a runtime condition.
  throw new Error(
    `bb-shared worker: pipeline exhausted without a response (last stage: "${stages[stages.length - 1]?.name ?? "<empty>"}")`,
  );
}
