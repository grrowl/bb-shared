import { describe, expect, it } from "vitest";
import {
  filterSystemConfig,
  filterSidebarBootstrap,
  filterProjectDetail,
  emptyPluginsResponse,
  emptyHostsResponse,
  emptyPluginSettingsResponse,
  matchResponseFilter,
  responseFiltersStage,
} from "../src/stages/response-filters.js";
import { EMPTY_SCOPE, type GuestScope } from "../src/scope.js";
import type { RequestContext } from "../src/pipeline.js";
import type { TunnelRouter } from "../src/tunnel/interface.js";

// ---------------------------------------------------------------------------
// Synthetic scope: thread T_IN (in project P_IN, section SEC_IN) is shared;
// everything with an _OUT suffix is not.
// ---------------------------------------------------------------------------
const T_IN = "thr_in";
const T_IN_2 = "thr_in_2";
const T_OUT = "thr_out";
const P_IN = "proj_in";
const P_OUT = "proj_out";
const SEC_IN = "sec_in";
const SEC_OUT = "sec_out";

const SCOPE: GuestScope = {
  threadIds: new Set([T_IN, T_IN_2]),
  projectIds: new Set([P_IN]),
};

// ---------------------------------------------------------------------------
// Fixtures — realistic instances of bb's server-contract response schemas
// (packages/server-contract/src/api/{system,projects,plugins}.ts).
// ---------------------------------------------------------------------------

function threadEntry(
  id: string,
  projectId: string,
  sectionId: string | null,
): Record<string, unknown> {
  // Shape from threadListEntrySchema (threadWithRuntime + list extras).
  return {
    id,
    projectId,
    environmentId: null,
    providerId: "anthropic",
    title: `Thread ${id}`,
    titleFallback: null,
    sectionId,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "normal",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    runtime: { kind: "idle" },
    activity: { kind: "idle" },
    pinSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    environmentWorkspaceDisplayKind: "none",
  };
}

function projectWithThreads(
  id: string,
  name: string,
  threads: Record<string, unknown>[],
): Record<string, unknown> {
  // Shape from projectWithThreadsResponseSchema (project + sources + threads).
  return {
    id,
    kind: "standard",
    name,
    gitRemoteUrl: null,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_699_000_500_000,
    sources: [
      {
        id: `src_${id}`,
        projectId: id,
        isDefault: true,
        type: "local_path",
        hostId: "host_owner",
        // A real owner path — must never leak to a guest.
        path: `/Users/owner/code/${name}`,
        createdAt: 1_699_000_000_000,
        updatedAt: 1_699_000_000_000,
      },
    ],
    threads,
    defaultExecutionOptions: null,
  };
}

function sidebarBootstrapFixture(): Record<string, unknown> {
  return {
    sections: [
      { id: SEC_IN, name: "Shared work", createdAt: 1, updatedAt: 2 },
      { id: SEC_OUT, name: "Owner private", createdAt: 3, updatedAt: 4 },
    ],
    projects: [
      projectWithThreads(P_IN, "shared-project", [
        threadEntry(T_IN, P_IN, SEC_IN),
        threadEntry(T_OUT, P_IN, SEC_OUT), // out-of-scope thread in shared project
        threadEntry(T_IN_2, P_IN, null), // in-scope, no section
      ]),
      projectWithThreads(P_OUT, "owner-secret-project", [
        threadEntry("thr_secret", P_OUT, SEC_OUT),
      ]),
    ],
    personalProject: projectWithThreads("proj_personal", "Personal", [
      threadEntry("thr_personal", "proj_personal", null),
    ]),
  };
}

function systemConfigFixture(): Record<string, unknown> {
  // Shape from systemConfigResponseSchema.
  return {
    generalSettings: { telemetryEnabled: false, confirmBeforeQuit: true },
    keybindings: { "thread.new": "mod+n", "settings.open": "mod+," },
    defaultKeybindings: { "thread.new": "mod+n" },
    keybindingOverrides: { "settings.open": "mod+," },
    experiments: { fancyThing: true },
    appearance: { kind: "builtin", id: "dark" },
    customThemes: ["solarized"],
    pluginThemes: [],
    featureFlags: { newSidebar: true },
    hostDaemonPort: 39_100,
    localHelperPorts: [39_101],
    serverUrl: "http://127.0.0.1:38886",
    primaryHostId: "host_owner",
    primaryHostPlatform: "macos",
    voiceTranscriptionEnabled: true,
    aiServices: {
      inference: "anthropic/claude-opus",
      inferenceFallback: null,
      transcription: "openai/whisper",
      services: [{ id: "anthropic", label: "Anthropic", configured: true }],
    },
    dataDir: "/Users/owner/.bb",
  };
}

// =========================================================================
// filterSystemConfig
// =========================================================================

describe("filterSystemConfig", () => {
  const filtered = filterSystemConfig(systemConfigFixture(), SCOPE);

  it("strips aiServices, keybindings, and voiceTranscriptionEnabled", () => {
    expect(filtered.aiServices).toBeUndefined();
    expect(filtered.keybindings).toBeUndefined();
    expect(filtered.voiceTranscriptionEnabled).toBeUndefined();
  });

  it("keeps theme + shell config untouched", () => {
    expect(filtered.appearance).toEqual({ kind: "builtin", id: "dark" });
    expect(filtered.customThemes).toEqual(["solarized"]);
    expect(filtered.generalSettings).toEqual({
      telemetryEnabled: false,
      confirmBeforeQuit: true,
    });
    expect(filtered.featureFlags).toEqual({ newSidebar: true });
    expect(filtered.serverUrl).toBe("http://127.0.0.1:38886");
  });

  it("strips aiServices deeply — the configured inference model is gone", () => {
    expect(JSON.stringify(filtered)).not.toContain("whisper");
    expect(JSON.stringify(filtered)).not.toContain("claude-opus");
  });

  it("keeps defaultKeybindings/keybindingOverrides (ticket strips only `keybindings`)", () => {
    // The ticket names exactly three fields; the two other keybinding fields
    // are UI shell config and pass through by design.
    expect(filtered.defaultKeybindings).toEqual({ "thread.new": "mod+n" });
    expect(filtered.keybindingOverrides).toEqual({ "settings.open": "mod+," });
  });

  it("degrades to an empty object on non-object upstream", () => {
    expect(filterSystemConfig(null, SCOPE)).toEqual({});
    expect(filterSystemConfig("nope", SCOPE)).toEqual({});
  });

  it("is scope-independent (same output under EMPTY_SCOPE)", () => {
    expect(filterSystemConfig(systemConfigFixture(), EMPTY_SCOPE)).toEqual(
      filtered,
    );
  });
});

// =========================================================================
// filterSidebarBootstrap
// =========================================================================

describe("filterSidebarBootstrap", () => {
  const filtered = filterSidebarBootstrap(sidebarBootstrapFixture(), SCOPE);
  const projects = filtered.projects as Record<string, unknown>[];

  it("drops projects with no share", () => {
    const ids = projects.map((p) => p.id);
    expect(ids).toEqual([P_IN]);
    expect(JSON.stringify(filtered)).not.toContain("owner-secret-project");
  });

  it("keeps only in-scope threads within a surviving project", () => {
    const threads = projects[0]!.threads as Record<string, unknown>[];
    const ids = threads.map((t) => t.id).sort();
    expect(ids).toEqual([T_IN, T_IN_2].sort());
  });

  it("does not leak the out-of-scope thread from the shared project", () => {
    expect(JSON.stringify(filtered)).not.toContain(T_OUT);
  });

  it("filters sections to those grouping a surviving in-scope thread", () => {
    const sections = filtered.sections as Record<string, unknown>[];
    expect(sections.map((s) => s.id)).toEqual([SEC_IN]);
    // The owner-private section (only held out-of-scope threads) is gone.
    expect(JSON.stringify(filtered)).not.toContain("Owner private");
  });

  it("replaces personalProject with an inert empty-thread stub", () => {
    const personal = filtered.personalProject as Record<string, unknown>;
    expect(personal.id).toBe("proj_personal");
    expect(personal.threads).toEqual([]);
    expect(personal.sources).toEqual([]);
    // The owner's personal thread + path must not survive.
    expect(JSON.stringify(personal)).not.toContain("thr_personal");
  });

  it("leaks no source from out-of-scope or personal projects", () => {
    // The in-scope project's sources are retained on purpose — the guest is
    // authorized for it and the SPA reads `sources` to render the project. But
    // no source from a project the guest cannot see must survive.
    const s = JSON.stringify(filtered);
    expect(s).not.toContain("/Users/owner/code/owner-secret-project");
    expect(s).not.toContain("src_proj_out");
    // The personal project's stub carries no sources at all.
    expect(
      (filtered.personalProject as Record<string, unknown>).sources,
    ).toEqual([]);
  });

  it("returns an empty scoped view under EMPTY_SCOPE", () => {
    const empty = filterSidebarBootstrap(sidebarBootstrapFixture(), EMPTY_SCOPE);
    expect(empty.projects).toEqual([]);
    expect(empty.sections).toEqual([]);
    expect((empty.personalProject as Record<string, unknown>).threads).toEqual(
      [],
    );
  });

  it("degrades closed on malformed upstream", () => {
    const out = filterSidebarBootstrap({ garbage: true }, SCOPE);
    expect(out.projects).toEqual([]);
    expect(out.sections).toEqual([]);
    expect(out.personalProject).toBeDefined();
  });
});

// =========================================================================
// Constant filters
// =========================================================================

describe("constant filters", () => {
  it("plugins → { plugins: [] }", () => {
    expect(emptyPluginsResponse()).toEqual({ plugins: [] });
  });
  it("hosts → []", () => {
    expect(emptyHostsResponse()).toEqual([]);
  });
  it("plugin-settings → {}", () => {
    expect(emptyPluginSettingsResponse()).toEqual({});
  });
});

// =========================================================================
// matchResponseFilter — routing table
// =========================================================================

describe("filterProjectDetail (issue 24)", () => {
  const projectDetail = () => ({
    id: P_IN,
    name: "In Project",
    sources: [{ path: "/Users/owner/secret/repo" }],
    threads: [
      threadEntry(T_IN, P_IN, SEC_IN),
      threadEntry(T_OUT, P_IN, SEC_OUT),
    ],
    sections: [
      { id: SEC_IN, name: "In" },
      { id: SEC_OUT, name: "Out" },
    ],
  });

  it("keeps in-scope sources but scopes threads + sections to the token", () => {
    const out = filterProjectDetail(projectDetail(), SCOPE);
    // The project is in scope (the token holds a thread in it), so its repo
    // paths are fine to show; only the thread list is scoped.
    expect(out.sources).toEqual([{ path: "/Users/owner/secret/repo" }]);
    expect((out.threads as { id: string }[]).map((t) => t.id)).toEqual([T_IN]);
    expect((out.sections as { id: string }[]).map((s) => s.id)).toEqual([
      SEC_IN,
    ]);
    // Non-secret metadata survives.
    expect(out.id).toBe(P_IN);
    expect(out.name).toBe("In Project");
  });

  it("degrades closed for a project not in scope", () => {
    const out = filterProjectDetail(
      { ...projectDetail(), id: P_OUT },
      SCOPE,
    );
    expect(out).toEqual({});
  });

  it("degrades closed on malformed upstream", () => {
    expect(filterProjectDetail(null, SCOPE)).toEqual({});
    expect(filterProjectDetail("nope", EMPTY_SCOPE)).toEqual({});
  });
});

describe("matchResponseFilter", () => {
  it("reshapes a specific project, not the bare list or subpaths (issue 24)", () => {
    expect(matchResponseFilter("GET", "/api/v1/projects/proj_in")?.kind).toBe(
      "reshape",
    );
    // trailing slash normalizes to the same match (issue 25 interaction).
    expect(matchResponseFilter("GET", "/api/v1/projects/proj_in/")?.kind).toBe(
      "reshape",
    );
    // bare list → not matched (authz denies it)
    expect(matchResponseFilter("GET", "/api/v1/projects")).toBeNull();
    // a project-nested thread path is the thread's own concern, not reshaped
    expect(
      matchResponseFilter("GET", "/api/v1/projects/proj_in/threads/thr_in"),
    ).toBeNull();
    // writes never reshape
    expect(matchResponseFilter("DELETE", "/api/v1/projects/proj_in")).toBeNull();
  });

  it("matches the five GET endpoints", () => {
    expect(matchResponseFilter("GET", "/api/v1/system/config")?.kind).toBe(
      "reshape",
    );
    expect(matchResponseFilter("GET", "/api/v1/sidebar-bootstrap")?.kind).toBe(
      "reshape",
    );
    expect(matchResponseFilter("GET", "/api/v1/plugins")?.kind).toBe("constant");
    expect(matchResponseFilter("GET", "/api/v1/hosts")?.kind).toBe("constant");
    expect(
      matchResponseFilter("GET", "/api/v1/plugin-settings/bb-shared")?.kind,
    ).toBe("constant");
  });

  it("matches a trailing-slash variant, closing the authz prefix gap (issue 25)", () => {
    // /authz allows `/api/v1/plugins/` (it normalizes the trailing slash), so
    // the filter must catch it too or the real inventory leaks.
    expect(matchResponseFilter("GET", "/api/v1/plugins/")?.kind).toBe(
      "constant",
    );
    expect(matchResponseFilter("GET", "/api/v1/hosts/")?.kind).toBe("constant");
    expect(matchResponseFilter("GET", "/api/v1/system/config/")?.kind).toBe(
      "reshape",
    );
  });

  it("does not match writes (left to the mutation gate)", () => {
    expect(matchResponseFilter("POST", "/api/v1/system/config")).toBeNull();
    expect(matchResponseFilter("PUT", "/api/v1/plugin-settings/x")).toBeNull();
  });

  it("does not match unrelated GETs", () => {
    expect(matchResponseFilter("GET", "/api/v1/threads/thr_in")).toBeNull();
    // sub-paths of /hosts and /plugins are the route-lockout / mutation gate's
    // job, not a blanket empty here.
    expect(matchResponseFilter("GET", "/api/v1/hosts/h1/directory")).toBeNull();
    expect(matchResponseFilter("GET", "/api/v1/plugins/x/assets/a")).toBeNull();
  });
});

// =========================================================================
// responseFiltersStage — pipeline wiring
// =========================================================================

function ctxFor(
  method: string,
  pathname: string,
  scope: GuestScope | null,
): RequestContext {
  const url = new URL(`https://guests-abc.workers.dev${pathname}`);
  return {
    request: new Request(url, { method }),
    url,
    env: {} as never,
    ctx: {} as never,
    workerPublicOrigin: url.origin,
    token: "bbsh_" + "A".repeat(32),
    scope,
    perms: null,
  };
}

function jsonRouter(body: unknown, init?: ResponseInit): TunnelRouter {
  return {
    acceptTunnelDial: () => {
      throw new Error("acceptTunnelDial should not be called");
    },
    dispatch: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
  };
}

const explodingRouter: TunnelRouter = {
  acceptTunnelDial: () => {
    throw new Error("acceptTunnelDial should not be called");
  },
  dispatch: () => {
    throw new Error("dispatch should not be called for this case");
  },
};

describe("responseFiltersStage", () => {
  it("passes an unmatched request straight through (continue)", async () => {
    const stage = responseFiltersStage(explodingRouter);
    const result = await stage.run(ctxFor("GET", "/api/v1/threads/x", SCOPE));
    expect(result.kind).toBe("continue");
  });

  it("answers a constant path WITHOUT dispatching upstream", async () => {
    // explodingRouter proves no tunnel hop happens for /plugins.
    const stage = responseFiltersStage(explodingRouter);
    const result = await stage.run(ctxFor("GET", "/api/v1/plugins", SCOPE));
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(await result.response.json()).toEqual({ plugins: [] });
    }
  });

  it("dispatches + reshapes a reshape path", async () => {
    const stage = responseFiltersStage(jsonRouter(sidebarBootstrapFixture()));
    const result = await stage.run(
      ctxFor("GET", "/api/v1/sidebar-bootstrap", SCOPE),
    );
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      const body = (await result.response.json()) as Record<string, unknown>;
      expect((body.projects as unknown[]).length).toBe(1);
      expect(JSON.stringify(body)).not.toContain("owner-secret-project");
    }
  });

  it("treats a null scope as EMPTY_SCOPE (deny-everything)", async () => {
    const stage = responseFiltersStage(jsonRouter(sidebarBootstrapFixture()));
    const result = await stage.run(
      ctxFor("GET", "/api/v1/sidebar-bootstrap", null),
    );
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      const body = (await result.response.json()) as Record<string, unknown>;
      expect(body.projects).toEqual([]);
    }
  });

  it("passes a non-200 upstream through untouched on a reshape path", async () => {
    const stage = responseFiltersStage(
      jsonRouter({ error: "tunnel_offline" }, { status: 503 }),
    );
    const result = await stage.run(
      ctxFor("GET", "/api/v1/system/config", SCOPE),
    );
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(result.response.status).toBe(503);
      expect(await result.response.json()).toEqual({ error: "tunnel_offline" });
    }
  });

  it("passes a non-JSON 200 upstream through untouched", async () => {
    const htmlRouter: TunnelRouter = {
      acceptTunnelDial: () => {
        throw new Error("nope");
      },
      dispatch: async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    };
    const stage = responseFiltersStage(htmlRouter);
    const result = await stage.run(
      ctxFor("GET", "/api/v1/system/config", SCOPE),
    );
    expect(result.kind).toBe("respond");
    if (result.kind === "respond") {
      expect(await result.response.text()).toBe("<html></html>");
    }
  });
});
