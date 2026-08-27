/**
 * Guest authorization scope.
 *
 * The resolved set of ids a token grants a guest. Produced from the plugin's
 * `/authz` response (issue 06) by the authz stage (issue 10): `thread_scope`
 * becomes `threadIds`, and `projectIds` is the union of `project_id`s across
 * the token's shares. Every scope-enforcing stage (09 filters, 10 mutation
 * gate, 11 WS frame filter) consumes this shape rather than re-deriving it.
 *
 * Kept as a standalone module so `pipeline.ts` (generic infra) and the stages
 * can both reference the type without a dependency cycle.
 */
export interface GuestScope {
  /** Thread ids the token covers — `S.thread_scope` in the spike-03 catalog. */
  readonly threadIds: ReadonlySet<string>;
  /** Projects referenced by any share — `S.project_scope` in the catalog. */
  readonly projectIds: ReadonlySet<string>;
}

/**
 * The deny-everything scope. Used when no authz stage has populated
 * `ctx.scope` yet: pong/ping still flow, but every thread/project frame is
 * dropped. Safe-by-default — a guest with an unresolved scope observes
 * nothing about any thread or project.
 */
export const EMPTY_SCOPE: GuestScope = {
  threadIds: new Set(),
  projectIds: new Set(),
};
