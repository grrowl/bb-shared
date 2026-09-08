// Explicit projections of BB bootstrap responses for a guest session.
import type { GuestScope } from "./scope";
const API = "/api/v1";
const SYSTEM_CONFIG_PATH = `${API}/system/config`;
const SIDEBAR_BOOTSTRAP_PATH = `${API}/sidebar-bootstrap`;
const PLUGINS_PATH = `${API}/plugins`;
const HOSTS_PATH = `${API}/hosts`;
const PLUGIN_SETTINGS_PREFIX = `${API}/plugin-settings/`;
const PROJECT_DETAIL_RE = /^\/api\/v1\/projects\/[^/]+$/;
const PERSONAL_PROJECT_ID = "proj_personal";

export function filterSystemConfig(upstream: unknown, _scope: GuestScope): Record<string, unknown> {
  if (!isRecord(upstream)) return {};
  const result: Record<string, unknown> = {};
  for (const key of ["generalSettings", "defaultKeybindings", "experiments", "appearance", "featureFlags"]) {
    if (key in upstream) result[key] = upstream[key];
  }
  return { ...result, keybindings: [], keybindingOverrides: [], customThemes: [], pluginThemes: [], hostDaemonPort: null, serverUrl: "", primaryHostId: null, primaryHostPlatform: null, voiceTranscriptionEnabled: false, dataDir: "" };
}

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
    .map((project) => ({ ...projectMetadata(project), threads: scopedThreads(project.threads, scope) }));

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

  const personal = upstream.personalProject;
  const personalProject = isRecord(personal) && typeof personal.id === "string" && scope.projectIds.has(personal.id)
    ? filterProjectDetail(personal, scope) : stub;
  return { sections, projects, personalProject };
}

export function filterProjectDetail(
  upstream: unknown,
  scope: GuestScope,
): Record<string, unknown> {
  if (!isRecord(upstream)) return {};
  if (typeof upstream.id === "string" && !scope.projectIds.has(upstream.id)) {
    return {};
  }

  const threads = scopedThreads(upstream.threads, scope);
  const result: Record<string, unknown> = { ...projectMetadata(upstream), threads };

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

export function emptyPluginsResponse(): { plugins: [] } {
  return { plugins: [] };
}

export function emptyHostsResponse(): [] {
  return [];
}

export function emptyPluginSettingsResponse(): Record<string, never> {
  return {};
}

type FilterMatch =
  | { kind: "reshape"; filter: (upstream: unknown, scope: GuestScope) => unknown }
  | { kind: "constant"; value: unknown };

export function matchResponseFilter(
  method: string,
  rawPathname: string,
): FilterMatch | null {
  if (method !== "GET") return null;

  const pathname =
    rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;

  switch (pathname) {
    case SYSTEM_CONFIG_PATH:
      return { kind: "reshape", filter: filterSystemConfig };
    case SIDEBAR_BOOTSTRAP_PATH:
      return { kind: "reshape", filter: filterSidebarBootstrap };
    case `${API}/plugins/contributions`:
      return { kind: "constant", value: { cliCommands: [], mentionProviders: [] } };
    case PLUGINS_PATH:
      return { kind: "constant", value: emptyPluginsResponse() };
    case HOSTS_PATH:
      return { kind: "constant", value: emptyHostsResponse() };
    default:
      if (/^\/api\/v1\/threads\/[^/]+\/tabs$/.test(pathname)) return { kind: "constant", value: { revision: 0, tabs: [] } };
      if (pathname.startsWith(PLUGIN_SETTINGS_PREFIX)) {
        return { kind: "constant", value: emptyPluginSettingsResponse() };
      }
      if (PROJECT_DETAIL_RE.test(pathname)) {
        return { kind: "reshape", filter: filterProjectDetail };
      }
      return null;
  }
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectMetadata(upstream: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { sources: [], defaultExecutionOptions: null };
  for (const key of ["id", "kind", "name", "gitRemoteUrl", "createdAt", "updatedAt"]) if (key in upstream) result[key] = upstream[key];
  return result;
}