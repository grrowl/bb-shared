/**
 * Stage 09: guest-scope response filters.
 *
 * The bb SPA has no user or session concept — every guest is served the real
 * SPA and all scoping happens here, at the proxy, by reshaping the JSON of a
 * handful of bootstrap endpoints (SPEC → "Scope enforcement → Response
 * filters"). A guest whose token covers thread `T` in project `P` must see a
 * sidebar containing only `T`, a system config with the owner's AI/keybinding
 * config stripped, no plugin frontends, and no host inventory.
 *
 * Each endpoint gets a *pure* filter: `(upstream, scope) → filtered`. Two of
 * them (`/system/config`, `/sidebar-bootstrap`) genuinely reshape the owner's
 * upstream JSON, so the stage dispatches through the tunnel, then rewrites the
 * body. The other three (`/plugins`, `/hosts`, `/plugin-settings/*`) collapse
 * to a constant that discloses nothing, so the stage answers them without ever
 * touching the tunnel — the owner's data never leaves the local bb.
 *
 * Scope source: `ctx.scope`, populated upstream by the authz stage (issue 10)
 * from the token's shares. Absent (null) ⇒ `EMPTY_SCOPE` ⇒ deny everything:
 * an empty sidebar, no projects, no threads. Safe-by-default — a guest whose
 * scope has not been resolved observes nothing.
 *
 * The response shapes mirrored here are captured from bb's server-contract
 * (`packages/server-contract/src/api/{system,projects,plugins}.ts`); the test
 * fixtures are realistic instances of those schemas.
 */

import { cont, respond, type Stage } from "../pipeline.js";
import { EMPTY_SCOPE, type GuestScope } from "../scope.js";
import type { TunnelRouter } from "../tunnel/interface.js";

// bb mounts its public API under `/api/v1` (`apps/server/src/server.ts`), and
// the SPA's API base is `window.location.origin` — so the guest hits these
// exact paths through the worker.
const API = "/api/v1";
const SYSTEM_CONFIG_PATH = `${API}/system/config`;
const SIDEBAR_BOOTSTRAP_PATH = `${API}/sidebar-bootstrap`;
const PLUGINS_PATH = `${API}/plugins`;
const HOSTS_PATH = `${API}/hosts`;
// NOTE: bb's real plugin-settings route is `/api/v1/plugins/:id/settings`, but
// the SPEC/ticket pin this filter to `/api/v1/plugin-settings/*`. A guest never
// reaches either: the plugin inventory below is empty, so no frontend loads to
// request settings, and the mutation gate (issue 10) denies everything else by
// default. This filter is belt-and-braces for the ticket-specified path.
const PLUGIN_SETTINGS_PREFIX = `${API}/plugin-settings/`;
// A specific project's detail: `GET /api/v1/projects/{p}` (single id segment,
// no further subpath). Authz already denies an out-of-scope project (issue 24),
// but the body of an in-scope one still carries `sources` (host filesystem
// paths) and sibling threads, so it gets reshaped like the sidebar.
const PROJECT_DETAIL_RE = /^\/api\/v1\/projects\/[^/]+$/;

// The personal-project stub returned to guests. bb's SPA requires a
// non-nullable `personalProject` in the bootstrap (it reads `.id`, `.name` and
// `.threads`), so we hand back a valid but inert `ProjectWithThreadsResponse`
// rather than the owner's real one — whose `sources` carry host filesystem
// paths and whose `threads` are entirely out of scope.
const PERSONAL_PROJECT_ID = "proj_personal";

// ---------------------------------------------------------------------------
// Pure filters — (upstream JSON, scope) → filtered JSON
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/system/config`. Strip the three owner-only fields the ticket
 * names — `aiServices` (the AI-service chooser + configured inference), the
 * resolved `keybindings`, and `voiceTranscriptionEnabled` — and pass the rest
 * (theme/appearance, general settings, feature flags, the UI shell config)
 * through untouched. Object-rest keeps this forward-compatible: fields bb adds
 * later flow through by default, which is the correct bias for shell config.
 */
export function filterSystemConfig(
  upstream: unknown,
  _scope: GuestScope,
): Record<string, unknown> {
  if (!isRecord(upstream)) return {};
  const {
    aiServices: _aiServices,
    keybindings: _keybindings,
    voiceTranscriptionEnabled: _voiceTranscriptionEnabled,
    ...rest
  } = upstream;
  return rest;
}

/**
 * `GET /api/v1/sidebar-bootstrap`. Reshape the owner's full navigation into the
 * guest's scoped view:
 *
 *   - `projects`: drop any project the token has no share in (its mere presence
 *     leaks the project's existence + name), and within the surviving projects
 *     keep only threads whose id is in scope.
 *   - `sections`: keep only the thread-sections that still group at least one
 *     in-scope thread; an empty section would name owner structure for no use.
 *   - `personalProject`: replace with the inert stub. A thread shared *from* the
 *     personal project therefore does not appear in the guest's rail under v0 —
 *     its deep-link URL still opens it, and per-thread access is gated by 10.
 *
 * Malformed upstream degrades closed (empty projects/sections + stub).
 */
export function filterSidebarBootstrap(
  upstream: unknown,
  scope: GuestScope,
): Record<string, unknown> {
  const stub = emptyPersonalProjectStub();
  if (!isRecord(upstream)) {
    return { sections: [], projects: [], personalProject: stub };
  }

  const rawProjects = Array.isArray(upstream.projects) ? upstream.projects : [];
  const projects = rawProjects
    .filter(
      (project): project is Record<string, unknown> =>
        isRecord(project) &&
        typeof project.id === "string" &&
        scope.projectIds.has(project.id),
    )
    .map((project) => ({
      ...project,
      threads: scopedThreads(project.threads, scope),
    }));

  // Section is allowed iff some surviving in-scope thread lives in it.
  const allowedSectionIds = new Set<string>();
  for (const project of projects) {
    for (const thread of project.threads) {
      if (isRecord(thread) && typeof thread.sectionId === "string") {
        allowedSectionIds.add(thread.sectionId);
      }
    }
  }
  const rawSections = Array.isArray(upstream.sections) ? upstream.sections : [];
  const sections = rawSections.filter(
    (section): section is Record<string, unknown> =>
      isRecord(section) &&
      typeof section.id === "string" &&
      allowedSectionIds.has(section.id),
  );

  return { sections, projects, personalProject: stub };
}

/**
 * `GET /api/v1/projects/{p}`. Reshape one project's detail to the guest's
 * scope (issue 24): strip `sources` (host filesystem paths), keep only in-scope
 * threads, and keep only sections that still group a surviving thread. Degrades
 * closed — a body for a project not in scope (authz should already have denied
 * it) returns empty.
 */
export function filterProjectDetail(
  upstream: unknown,
  scope: GuestScope,
): Record<string, unknown> {
  if (!isRecord(upstream)) return {};
  // Defense in depth: authz denies an out-of-scope project, but if an
  // unexpected body arrives, disclose nothing.
  if (typeof upstream.id === "string" && !scope.projectIds.has(upstream.id)) {
    return {};
  }

  const { sources: _sources, ...rest } = upstream;
  const threads = scopedThreads(upstream.threads, scope);
  const result: Record<string, unknown> = { ...rest, sources: [], threads };

  // If the project carries its own sections, keep only those grouping a
  // surviving in-scope thread (mirrors the sidebar-bootstrap filter).
  if (Array.isArray(upstream.sections)) {
    const allowed = new Set<string>();
    for (const thread of threads) {
      if (typeof thread.sectionId === "string") allowed.add(thread.sectionId);
    }
    result.sections = upstream.sections.filter(
      (section): section is Record<string, unknown> =>
        isRecord(section) &&
        typeof section.id === "string" &&
        allowed.has(section.id),
    );
  }
  return result;
}

/** `GET /api/v1/plugins`. v0 disables every plugin frontend for guests. */
export function emptyPluginsResponse(): { plugins: [] } {
  return { plugins: [] };
}

/** `GET /api/v1/hosts`. Guests get no host inventory. */
export function emptyHostsResponse(): [] {
  return [];
}

/** `GET /api/v1/plugin-settings/*`. Nothing to disclose. */
export function emptyPluginSettingsResponse(): Record<string, never> {
  return {};
}

// ---------------------------------------------------------------------------
// Match table
// ---------------------------------------------------------------------------

/**
 * A `reshape` match must fetch the owner's upstream and rewrite it; a
 * `constant` match answers from a fixed value without ever hitting the tunnel.
 */
type FilterMatch =
  | { kind: "reshape"; filter: (upstream: unknown, scope: GuestScope) => unknown }
  | { kind: "constant"; value: unknown };

/**
 * Decide which filter (if any) owns this request. Only guest GETs are
 * candidates — writes are the mutation gate's job (issue 10), and a filter that
 * silently swallowed a POST would mask a scoping bug. Returns null for
 * everything this stage does not own, which falls through to normal dispatch.
 */
export function matchResponseFilter(
  method: string,
  rawPathname: string,
): FilterMatch | null {
  if (method !== "GET") return null;

  // Normalize a trailing slash away before matching. The plugin's /authz
  // normalizes trailing slashes (authz.ts `normalizePath`), so it ALLOWS
  // `/api/v1/plugins/`; if this exact-match matcher did not do the same, that
  // request would miss the filter and leak the real plugin/host inventory
  // (issue 25). Keep the two surfaces defined by the same normalization.
  const pathname =
    rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;

  switch (pathname) {
    case SYSTEM_CONFIG_PATH:
      return { kind: "reshape", filter: filterSystemConfig };
    case SIDEBAR_BOOTSTRAP_PATH:
      return { kind: "reshape", filter: filterSidebarBootstrap };
    case PLUGINS_PATH:
      return { kind: "constant", value: emptyPluginsResponse() };
    case HOSTS_PATH:
      return { kind: "constant", value: emptyHostsResponse() };
    default:
      if (pathname.startsWith(PLUGIN_SETTINGS_PREFIX)) {
        return { kind: "constant", value: emptyPluginSettingsResponse() };
      }
      // `GET /api/v1/projects/{p}` — shape the in-scope project body (24). A
      // bare `/api/v1/projects` list and any `/projects/{p}/...` subpath do not
      // match, so they are not reshaped here.
      if (PROJECT_DETAIL_RE.test(pathname)) {
        return { kind: "reshape", filter: filterProjectDetail };
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pipeline stage
// ---------------------------------------------------------------------------

/**
 * Insert BEFORE `dispatchStage` and AFTER the authz stage (issue 10) that
 * populates `ctx.scope`. For a matched reshape path this stage dispatches the
 * request itself and rewrites the body, so the terminal dispatch stage never
 * runs for it; for a constant path it answers directly; everything else
 * `continue`s to normal dispatch.
 *
 * Non-200 or non-JSON upstream on a reshape path is passed through untouched —
 * a 503 tunnel-offline or a 404 must reach the SPA as-is, not be masked by an
 * empty filtered body.
 */
export function responseFiltersStage(router: TunnelRouter): Stage {
  return {
    name: "response-filters",
    async run(ctx) {
      const match = matchResponseFilter(ctx.request.method, ctx.url.pathname);
      if (!match) return cont(ctx);

      if (match.kind === "constant") {
        return respond(jsonResponse(match.value));
      }

      const upstream = await router.dispatch(ctx.request);
      if (!isFilterableJson(upstream)) {
        return respond(upstream);
      }

      const scope = ctx.scope ?? EMPTY_SCOPE;
      const body = await upstream.json();
      return respond(jsonResponse(match.filter(body, scope)));
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scopedThreads(
  threads: unknown,
  scope: GuestScope,
): Record<string, unknown>[] {
  if (!Array.isArray(threads)) return [];
  return threads.filter(
    (thread): thread is Record<string, unknown> =>
      isRecord(thread) &&
      typeof thread.id === "string" &&
      scope.threadIds.has(thread.id),
  );
}

function emptyPersonalProjectStub(): Record<string, unknown> {
  return {
    id: PERSONAL_PROJECT_ID,
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    createdAt: 0,
    updatedAt: 0,
    sources: [],
    threads: [],
    defaultExecutionOptions: null,
  };
}

/** Only rewrite a successful JSON body; pass errors/redirects/HTML through. */
function isFilterableJson(response: Response): boolean {
  if (response.status !== 200) return false;
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.toLowerCase().includes("application/json");
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
