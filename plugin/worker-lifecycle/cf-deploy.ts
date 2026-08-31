// Cloudflare deploy pipeline (issue 07, absorbing former issue 13).
//
// The always-temp deploy path from spike 01 (`research/cf-temp-deployments.md`
// §"Path B"): solve the PoW challenge → provision an anonymous temp account →
// upload the bundled worker script (with the TunnelDO binding + our two
// secrets) via a raw multipart PUT → enable the workers.dev route → wait for
// route propagation → resolve the `*.workers.dev` URL.
//
// One code path, always temp (SPEC §"Worker lifecycle": "no wrangler dep, no
// branching"). Every deploy provisions a FRESH temp account, so the DO
// migration is always a first-time SQLite-backed migration; we never re-key a
// live account. Redeploy == a fresh provision with a freshly-minted tunnel
// secret.
//
// This pipeline was verified end to end against the LIVE Cloudflare API
// (research/cf-live-verification.md TASK 1). Three of its contracts cannot be
// caught by offline unit tests because they are live-API behaviours, so they
// are pinned by comments here and by ticket 30: the free-plan SQLite DO
// migration (error 10097), the raw multipart upload that the `cloudflare` SDK
// v7.1.0 `scripts.update` gets wrong (error 10021), and the ~15 s workers.dev
// route propagation after the per-script subdomain enable.
import { solveChallenge, type PowChallenge } from "./pow";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const CF_TERMS = "https://www.cloudflare.com/terms/";
const CF_PRIVACY = "https://www.cloudflare.com/privacypolicy/";

/** The two secret-text env vars the worker expects (worker/README.md). */
export const WORKER_ENV = {
  tunnelSecret: "TUNNEL_SECRET",
  authzToken: "AUTHZ_TOKEN",
} as const;

export interface DeployInput {
  /** Worker script name → `https://<scriptName>.<sub>.workers.dev`. */
  scriptName: string;
  /** `metadata.compatibility_date` — mirror worker/wrangler.toml. */
  compatibilityDate: string;
  /** Bundled worker source (ESM, exports default + the DO class). */
  scriptContent: string;
  /** Bearer the local SharedTunnel presents on `/__tunnel` (we mint it). */
  tunnelSecret: string;
  /** bb per-plugin token the worker presents to the plugin's authz route. */
  authzToken: string;
  /** DO class re-exported by the worker entry (worker/wrangler.toml). */
  doClassName: string;
  /** DO binding name the worker reads (`env.TUNNEL_DO`). */
  doBindingName: string;
  /** Migration tag for the first-time DO class migration. */
  migrationTag: string;
}

export interface DeployResult {
  url: string;
  deploymentId: string;
  accountId: string;
  /** CF temp-account bearer. Secret — persisted locally, never logged/exposed. */
  apiToken: string;
  /** Account self-destruct time (ms epoch), or null if CF omitted it. */
  expiresAt: number | null;
  /** Owner-only claim affordance surfaced in the UI (bearer — never to guests). */
  claim: { url: string; expiresAt: number | null };
}

export interface DeployOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Abortable sleep, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts of the whole provision+upload unit. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential). Default 1000. */
  backoffBaseMs?: number;
  /** Max workers.dev route-propagation probes after enabling. Default 10. */
  propagationProbes?: number;
  /** Interval between route-propagation probes in ms. Default 3000. */
  propagationIntervalMs?: number;
  log?: { info?(m: string): void; warn(m: string): void };
}

// ---------------------------------------------------------------------------
// CF REST envelope helpers.
// ---------------------------------------------------------------------------

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

class CfDeployError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
    this.name = "CfDeployError";
  }
}

// ---------------------------------------------------------------------------
// Secret redaction (M3, ticket 20).
//
// The tunnel secret and authz token are planted as `secret_text` bindings in
// the `scripts.update` request body. If the `cloudflare` SDK (or a lower-level
// fetch) throws an error whose message echoes that body, the raw secret would
// flow into `bb.log` via the deploy error path — breaking tunnel-secret.ts's
// "never written to bb.log" claim. Every deploy error string is passed through
// `redactSecrets` before it is logged (and thrown errors from the upload step
// are scrubbed at the source), so a secret can never reach a log sink.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  // bb-shared token handles / raw bearers and bb connect credentials.
  /bbsh_[A-Za-z0-9_-]+/g,
  /bbcm_[A-Za-z0-9_-]+/g,
  // 32+ char base64url runs — catches the 43-char tunnelSecret and any
  // long opaque token the SDK might echo (authz token, CF api token).
  /[A-Za-z0-9_-]{32,}/g,
];

/** Scrub any embedded secret-shaped value from a string bound for a log/throw. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** Redact the `.message` of an unknown thrown value. */
function redactErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}

interface CfRequestInit {
  /** Default POST. */
  method?: string;
  /** Bearer for temp-account-scoped calls (script upload, subdomain, route). */
  apiToken?: string;
  /** JSON body — sets `content-type: application/json`. */
  json?: unknown;
  /** Multipart body — fetch sets the `multipart/form-data` boundary itself. */
  form?: FormData;
}

/** Pull CF's `{code, message}` error detail off a non-2xx envelope, if any. */
async function cfErrorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as CfEnvelope<unknown>;
    const detail = (j.errors ?? [])
      .map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim())
      .join("; ");
    return detail ? `: ${detail}` : "";
  } catch {
    return "";
  }
}

async function cfRequest<T>(
  fetchImpl: typeof fetch,
  path: string,
  init: CfRequestInit = {},
): Promise<T> {
  const method = init.method ?? "POST";
  const headers: Record<string, string> = {};
  if (init.apiToken) headers.authorization = `Bearer ${init.apiToken}`;
  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form;
  } else if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json ?? {});
  }

  let res: Response;
  try {
    res = await fetchImpl(`${CF_API_BASE}${path}`, { method, headers, body });
  } catch (err) {
    // Network-layer failure — retriable.
    throw new CfDeployError(
      `CF ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) {
    // 5xx / 429 are worth retrying; 4xx (bad PoW, bad ToS, 10021/10097) are not.
    // Surface CF's error code so a live-only failure is diagnosable from the log.
    const retriable = res.status >= 500 || res.status === 429;
    throw new CfDeployError(
      `CF ${method} ${path} → HTTP ${res.status}${await cfErrorDetail(res)}`,
      retriable,
    );
  }
  const json = (await res.json()) as CfEnvelope<T>;
  if (!json.success) {
    const detail = (json.errors ?? [])
      .map((e) => e.message ?? e.code ?? "?")
      .join("; ");
    throw new CfDeployError(`CF ${method} ${path} unsuccessful: ${detail}`, false);
  }
  return json.result;
}

// ---------------------------------------------------------------------------
// Provisioning: challenge → solve → previews.
// ---------------------------------------------------------------------------

interface ProvisionedAccount {
  account: {
    id: string;
    name?: string;
    type?: string;
    apiToken: string;
    tokenId?: string;
    expiresAt?: string | null;
  };
  claim: { token: string; url: string; expiresAt?: string | null };
}

async function provisionAccount(
  fetchImpl: typeof fetch,
): Promise<ProvisionedAccount> {
  const challenge = await cfRequest<PowChallenge>(
    fetchImpl,
    "/provisioning/previews/challenge",
    { json: {} },
  );
  const solved = solveChallenge(challenge);
  return cfRequest<ProvisionedAccount>(fetchImpl, "/provisioning/previews", {
    json: {
      termsOfService: CF_TERMS,
      privacyPolicy: CF_PRIVACY,
      acceptTermsOfService: "yes",
      challengeToken: solved.challengeToken,
      solution: solved.solution,
    },
  });
}

// ---------------------------------------------------------------------------
// Upload: raw multipart PUT + subdomain read + per-script route enable.
//
// The `cloudflare` SDK v7.1.0 `scripts.update` mis-transmits the module body
// (CF rejects it with error 10021, a bogus syntax error at worker.js:1:4) —
// proven live in research/cf-live-verification.md TASK 1 bug 3, against BOTH the
// SDK's `new File()` and `toFile()` paths. So we build the multipart PUT
// directly, exactly as wrangler does: a JSON `metadata` part + a `worker.js`
// module part (`application/javascript+module`). No offline test can catch the
// SDK mismatch; ticket 30 carries it.
// ---------------------------------------------------------------------------

async function uploadScript(
  input: DeployInput,
  provisioned: ProvisionedAccount,
  fetchImpl: typeof fetch,
): Promise<{ url: string; deploymentId: string }> {
  return uploadWorkerScript({
    input,
    accountId: provisioned.account.id,
    bearer: provisioned.account.apiToken,
    fetchImpl,
  });
}

/**
 * Upload the bundled worker to a specific account with a specific bearer, then
 * enable its workers.dev route and resolve the live URL. Extracted from the
 * temporary deployment path. It is retained as the single provisioning upload
 * helper. Same raw multipart PUT (bug 3), same
 * per-script subdomain enable (bug 4).
 *
 * NOTE: the `migrations.new_sqlite_classes`
 * metadata is a first-time DO migration. Re-uploading onto a claimed script
 * whose DO class already exists may need a bare (no-migration) or `new_tag`
 * bump instead; this cannot be exercised offline (no registered client) and is
 * flagged for the live walk.
 */
export async function uploadWorkerScript(args: {
  input: DeployInput;
  accountId: string;
  /** Temporary-account bearer used only during provisioning/upload. */
  bearer: string;
  fetchImpl?: typeof fetch;
}): Promise<{ url: string; deploymentId: string }> {
  const { input, accountId } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const apiToken = args.bearer;
  const scriptPath = `/accounts/${accountId}/workers/scripts/${input.scriptName}`;

  const metadata = {
    main_module: "worker.js",
    compatibility_date: input.compatibilityDate,
    bindings: [
      {
        type: "durable_object_namespace",
        name: input.doBindingName,
        class_name: input.doClassName,
      },
      { type: "secret_text", name: WORKER_ENV.tunnelSecret, text: input.tunnelSecret },
      { type: "secret_text", name: WORKER_ENV.authzToken, text: input.authzToken },
    ],
    // Always a first-time migration: every deploy is a fresh temp account. Temp
    // accounts are free-plan, where DOs MUST be SQLite-backed — a legacy
    // `new_classes` migration is rejected with error 10097 (research bug 2).
    migrations: {
      new_tag: input.migrationTag,
      new_sqlite_classes: [input.doClassName],
    },
  };

  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set(
    "worker.js",
    new Blob([input.scriptContent], { type: "application/javascript+module" }),
    "worker.js",
  );

  // The multipart body carries the raw `secret_text` values. Wrap the upload so
  // any error (network layer, or a CF envelope that echoed the request) is
  // scrubbed of secrets before it can propagate to a log sink (M3, ticket 20).
  let deploymentId: string;
  try {
    const updated = await cfRequest<{ id?: string }>(fetchImpl, scriptPath, {
      method: "PUT",
      apiToken,
      form,
    });
    deploymentId = updated.id ?? input.scriptName;
  } catch (err) {
    throw new CfDeployError(
      `CF script upload failed: ${redactErrorMessage(err)}`,
      err instanceof CfDeployError ? err.retriable : false,
    );
  }

  const { subdomain } = await cfRequest<{ subdomain: string }>(
    fetchImpl,
    `/accounts/${accountId}/workers/subdomain`,
    { method: "GET", apiToken },
  );

  // Enable the workers.dev route for THIS script. Uploading a script does not
  // put it on `<script>.<sub>.workers.dev`; without this POST the URL 404s
  // indefinitely (research bug 4). wrangler issues the same call when
  // `workers_dev = true`.
  await cfRequest(fetchImpl, `${scriptPath}/subdomain`, {
    method: "POST",
    apiToken,
    json: { enabled: true, previews_enabled: false },
  });

  return {
    url: `https://${input.scriptName}.${subdomain}.workers.dev`,
    deploymentId,
  };
}

// ---------------------------------------------------------------------------
// Route propagation (research bug 4).
//
// Enabling the per-script workers.dev route is not instant — CF needs ~12-15 s
// to propagate it, during which the URL returns CF's generic 404 page. Probe
// the URL until it actually serves the worker (any non-404 status: the worker's
// own `GET /` gate answers 401 `token_missing`, which is the "it's live" signal)
// so `deployWorker` doesn't hand back a URL that 404s for the first ~15 s. This
// is a live-API timing contract with no offline analogue; bounded, and if it
// never comes up we return anyway and the health loop handles a dead worker.
// ---------------------------------------------------------------------------

async function waitForRoutePropagation(
  fetchImpl: typeof fetch,
  url: string,
  sleep: (ms: number) => Promise<void>,
  probes: number,
  intervalMs: number,
  log?: DeployOptions["log"],
): Promise<void> {
  for (let attempt = 1; attempt <= probes; attempt++) {
    try {
      const res = await fetchImpl(url, { method: "GET", redirect: "manual" });
      // A non-404, sub-500 status means the worker script is serving on the
      // route. 404 is CF's not-yet-propagated page; 5xx is a transient hiccup.
      if (res.status !== 404 && res.status < 500) return;
    } catch {
      // Network error mid-propagation — keep waiting.
    }
    if (attempt < probes) await sleep(intervalMs);
  }
  log?.warn(
    `workers.dev route did not propagate within ${(probes * intervalMs) / 1000}s; ` +
      "returning URL anyway (health loop will retry if it stays dead)",
  );
}

// ---------------------------------------------------------------------------
// Orchestration with retry/backoff.
// ---------------------------------------------------------------------------

function toMsEpoch(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * Provision a fresh temp account and upload the worker. Retries the whole unit
 * (a failed provision self-destructs on CF's side within 60 min) with capped
 * exponential backoff on retriable failures. Non-retriable failures (bad PoW,
 * rejected ToS, SDK 4xx) throw immediately.
 */
export async function deployWorker(
  input: DeployInput,
  opts: DeployOptions = {},
): Promise<DeployResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;
  const propagationProbes = opts.propagationProbes ?? 10;
  const propagationIntervalMs = opts.propagationIntervalMs ?? 3000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const provisioned = await provisionAccount(fetchImpl);
      const { url, deploymentId } = await uploadScript(
        input,
        provisioned,
        fetchImpl,
      );
      await waitForRoutePropagation(
        fetchImpl,
        url,
        sleep,
        propagationProbes,
        propagationIntervalMs,
        opts.log,
      );
      return {
        url,
        deploymentId,
        accountId: provisioned.account.id,
        apiToken: provisioned.account.apiToken,
        expiresAt: toMsEpoch(provisioned.account.expiresAt),
        claim: {
          url: provisioned.claim.url,
          expiresAt: toMsEpoch(provisioned.claim.expiresAt),
        },
      };
    } catch (err) {
      lastError = err;
      const retriable = !(err instanceof CfDeployError) || err.retriable;
      // Redact before logging: a lower-level error may still embed a secret
      // (M3, ticket 20). The final throw below preserves the original error for
      // the caller's own (already-redacted) log path.
      const message = redactErrorMessage(err);
      if (!retriable || attempt === maxAttempts) {
        opts.log?.warn(
          `worker deploy failed (attempt ${attempt}/${maxAttempts}): ${message}`,
        );
        break;
      }
      const delay = backoffBaseMs * 2 ** (attempt - 1);
      opts.log?.warn(
        `worker deploy attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms: ${message}`,
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`worker deploy failed: ${String(lastError)}`);
}

export { CfDeployError };
