// Cloudflare deploy pipeline (issue 07, absorbing former issue 13).
//
// The always-temp deploy path from spike 01 (`research/cf-temp-deployments.md`
// §"Path B"): solve the PoW challenge → provision an anonymous temp account →
// upload the bundled worker script (with the TunnelDO binding + our two
// secrets) via the `cloudflare` SDK → resolve the `*.workers.dev` URL.
//
// One code path, always temp (SPEC §"Worker lifecycle": "no wrangler dep, no
// branching"). Every deploy provisions a FRESH temp account, so the DO
// migration is always a first-time `new_classes` migration; we never re-key a
// live account. Redeploy == a fresh provision with a freshly-minted tunnel
// secret.
//
// No CF egress in the sandbox, so this is not integration-tested here; the PoW
// math (pow.ts) is unit-tested, and the network shape follows the spike's
// verbatim reference implementation.
import Cloudflare from "cloudflare";
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
  /** Injectable for tests. Defaults to `(name, token) => new Cloudflare(...)`. */
  clientFactory?: (apiToken: string) => Pick<Cloudflare, "workers">;
  /** Abortable sleep, injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts of the whole provision+upload unit. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential). Default 1000. */
  backoffBaseMs?: number;
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

async function cfPost<T>(
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${CF_API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    // Network-layer failure — retriable.
    throw new CfDeployError(
      `CF POST ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!res.ok) {
    // 5xx / 429 are worth retrying; 4xx (bad PoW, bad ToS) are not.
    const retriable = res.status >= 500 || res.status === 429;
    throw new CfDeployError(
      `CF POST ${path} → HTTP ${res.status}`,
      retriable,
    );
  }
  const json = (await res.json()) as CfEnvelope<T>;
  if (!json.success) {
    const detail = (json.errors ?? [])
      .map((e) => e.message ?? e.code ?? "?")
      .join("; ");
    throw new CfDeployError(`CF POST ${path} unsuccessful: ${detail}`, false);
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
  const challenge = await cfPost<PowChallenge>(
    fetchImpl,
    "/provisioning/previews/challenge",
    {},
  );
  const solved = solveChallenge(challenge);
  return cfPost<ProvisionedAccount>(fetchImpl, "/provisioning/previews", {
    termsOfService: CF_TERMS,
    privacyPolicy: CF_PRIVACY,
    acceptTermsOfService: "yes",
    challengeToken: solved.challengeToken,
    solution: solved.solution,
  });
}

// ---------------------------------------------------------------------------
// Upload: cloudflare SDK scripts.update + subdomains.get.
// ---------------------------------------------------------------------------

async function uploadScript(
  input: DeployInput,
  provisioned: ProvisionedAccount,
  clientFactory: NonNullable<DeployOptions["clientFactory"]>,
): Promise<{ url: string; deploymentId: string }> {
  const accountId = provisioned.account.id;
  const client = clientFactory(provisioned.account.apiToken);

  const workerModule = new File([input.scriptContent], "worker.js", {
    type: "application/javascript+module",
  });

  const updated = await client.workers.scripts.update(input.scriptName, {
    account_id: accountId,
    metadata: {
      main_module: "worker.js",
      compatibility_date: input.compatibilityDate,
      bindings: [
        {
          type: "durable_object_namespace",
          name: input.doBindingName,
          class_name: input.doClassName,
        },
        {
          type: "secret_text",
          name: WORKER_ENV.tunnelSecret,
          text: input.tunnelSecret,
        },
        {
          type: "secret_text",
          name: WORKER_ENV.authzToken,
          text: input.authzToken,
        },
      ],
      // Always a first-time migration: every deploy is a fresh temp account.
      migrations: {
        new_tag: input.migrationTag,
        new_classes: [input.doClassName],
      },
    },
    files: [workerModule],
  });

  const { subdomain } = await client.workers.subdomains.get({
    account_id: accountId,
  });

  return {
    url: `https://${input.scriptName}.${subdomain}.workers.dev`,
    deploymentId: updated.id ?? input.scriptName,
  };
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
  const clientFactory =
    opts.clientFactory ?? ((apiToken: string) => new Cloudflare({ apiToken }));
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoffBaseMs = opts.backoffBaseMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const provisioned = await provisionAccount(fetchImpl);
      const { url, deploymentId } = await uploadScript(
        input,
        provisioned,
        clientFactory,
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
      const message = err instanceof Error ? err.message : String(err);
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
