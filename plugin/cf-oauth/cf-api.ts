// Cloudflare REST calls made with an OAuth ACCESS TOKEN (issue 28 §11.3-11.4).
//
// After the owner connects, these reads ARE the claim confirmation: a signed,
// owner-consented discovery of CF's own state (list accounts → find our script
// → read the account's workers.dev subdomain → resolve the LIVE hostname). The
// live hostname is authoritative — the plugin never trusts a persisted URL,
// because a worker claimed into an existing account is served at that account's
// subdomain, so the hostname can change on claim (§10).
//
// Redeploy reuses the ticket-30-fixed upload path against the claimed account;
// undeploy is a direct DELETE. All network is behind an injectable `fetchImpl`,
// and the tunnel-secret disambiguation probe is its own seam, so the resolution
// logic unit-tests without a browser or a live account.
import { redactSecrets, uploadWorkerScript, type DeployInput } from "../worker-lifecycle/cf-deploy";
import { CF_API_BASE, CF_WORKER_SCRIPT_NAME } from "./oauth-constants";

export class CfApiError extends Error {
  constructor(
    message: string,
    /** True when the access token was rejected (401) → try a refresh. */
    readonly unauthorized: boolean = false,
  ) {
    super(message);
    this.name = "CfApiError";
  }
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

async function cfGet<T>(
  fetchImpl: typeof fetch,
  accessToken: string,
  path: string,
): Promise<T> {
  const res = await fetchImpl(`${CF_API_BASE}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  return unwrap<T>(res, "GET", path);
}

async function unwrap<T>(
  res: Response,
  method: string,
  path: string,
): Promise<T> {
  if (res.status === 401 || res.status === 403) {
    throw new CfApiError(`CF ${method} ${path} → HTTP ${res.status}`, true);
  }
  let json: CfEnvelope<T>;
  try {
    json = (await res.json()) as CfEnvelope<T>;
  } catch {
    throw new CfApiError(`CF ${method} ${path} → HTTP ${res.status} (non-JSON)`);
  }
  if (!res.ok || !json.success) {
    const detail = (json.errors ?? [])
      .map((e) => `${e.code ?? "?"} ${e.message ?? ""}`.trim())
      .join("; ");
    throw new CfApiError(
      redactSecrets(`CF ${method} ${path} unsuccessful: ${detail || res.status}`),
    );
  }
  return json.result;
}

export interface CfAccount {
  id: string;
  name?: string;
}

/** List the accounts the owner granted (`account:read`). */
export async function listAccounts(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<CfAccount[]> {
  const result = await cfGet<CfAccount[]>(fetchImpl, accessToken, "/accounts");
  return Array.isArray(result) ? result : [];
}

/** True iff `scriptName` exists under the account (`workers:read`). */
export async function accountHasScript(
  fetchImpl: typeof fetch,
  accessToken: string,
  accountId: string,
  scriptName: string,
): Promise<boolean> {
  const scripts = await cfGet<Array<{ id?: string }>>(
    fetchImpl,
    accessToken,
    `/accounts/${accountId}/workers/scripts`,
  );
  return (
    Array.isArray(scripts) && scripts.some((s) => s?.id === scriptName)
  );
}

/** Read the account's single workers.dev subdomain (`workers:read`). */
export async function getSubdomain(
  fetchImpl: typeof fetch,
  accessToken: string,
  accountId: string,
): Promise<string> {
  const result = await cfGet<{ subdomain?: string }>(
    fetchImpl,
    accessToken,
    `/accounts/${accountId}/workers/subdomain`,
  );
  if (!result?.subdomain) {
    throw new CfApiError(`account ${accountId} has no workers.dev subdomain`);
  }
  return result.subdomain;
}

/**
 * A tunnel-secret disambiguation probe (§11.3): dial a candidate worker's
 * `/__tunnel` with the given secret and report whether it is accepted. Injected
 * so the resolution logic tests without a real WebSocket; the default impl
 * lives in `tunnel-probe.ts`.
 */
export type TunnelSecretProbe = (
  hostname: string,
  tunnelSecret: string,
) => Promise<boolean>;

export interface ResolvedWorker {
  accountId: string;
  subdomain: string;
  hostname: string;
  url: string;
}

/**
 * Discover the claimed worker across all granted accounts (§11.3). Finds every
 * account holding `scriptName`, then:
 *  - 0 matches → null (not claimed / deleted in dashboard).
 *  - 1 match   → resolve its live hostname from the account subdomain.
 *  - >1 match  → disambiguate with the tunnel-secret probe: the real one is the
 *                account whose worker accepts OUR tunnelSecret handshake.
 * The returned hostname/URL is LIVE — never a persisted guess.
 */
export async function resolveClaimedWorker(args: {
  fetchImpl: typeof fetch;
  accessToken: string;
  scriptName?: string;
  /** Our current tunnel secret, for disambiguation only. */
  tunnelSecret?: string;
  probe?: TunnelSecretProbe;
}): Promise<ResolvedWorker | null> {
  const fetchImpl = args.fetchImpl;
  const accessToken = args.accessToken;
  const scriptName = args.scriptName ?? CF_WORKER_SCRIPT_NAME;

  const accounts = await listAccounts(fetchImpl, accessToken);
  const matches: string[] = [];
  for (const account of accounts) {
    if (await accountHasScript(fetchImpl, accessToken, account.id, scriptName)) {
      matches.push(account.id);
    }
  }
  if (matches.length === 0) return null;

  const resolve = async (accountId: string): Promise<ResolvedWorker> => {
    const subdomain = await getSubdomain(fetchImpl, accessToken, accountId);
    const hostname = `${scriptName}.${subdomain}.workers.dev`;
    return { accountId, subdomain, hostname, url: `https://${hostname}` };
  };

  if (matches.length === 1) return resolve(matches[0]);

  // Ambiguous: two accounts hold the script name. The genuine one answers our
  // tunnelSecret handshake; probe each candidate and pick the accepter.
  if (!args.tunnelSecret || !args.probe) {
    // Cannot disambiguate without both the secret and a probe — fail closed so
    // the caller can degrade rather than adopt the wrong account.
    throw new CfApiError(
      `found ${scriptName} under ${matches.length} accounts and cannot disambiguate (no tunnel-secret probe)`,
    );
  }
  for (const accountId of matches) {
    const candidate = await resolve(accountId);
    if (await args.probe(candidate.hostname, args.tunnelSecret)) {
      return candidate;
    }
  }
  return null; // none accepted our secret — treat as not adoptable
}

/**
 * Redeploy the worker onto the claimed account with the OAuth access token
 * (§11.4). Reuses the ticket-30-fixed multipart upload + route-enable path.
 */
export async function redeployClaimedWorker(args: {
  fetchImpl: typeof fetch;
  accessToken: string;
  accountId: string;
  input: DeployInput;
}): Promise<{ url: string; deploymentId: string }> {
  return uploadWorkerScript({
    input: args.input,
    accountId: args.accountId,
    bearer: args.accessToken,
    fetchImpl: args.fetchImpl,
  });
}

/**
 * Undeploy the claimed worker (§11.4): DELETE the script under the claimed
 * account. `force=true` removes it even with active bindings (the DO).
 */
export async function deleteClaimedWorker(args: {
  fetchImpl: typeof fetch;
  accessToken: string;
  accountId: string;
  scriptName?: string;
}): Promise<void> {
  const scriptName = args.scriptName ?? CF_WORKER_SCRIPT_NAME;
  const path = `/accounts/${args.accountId}/workers/scripts/${scriptName}?force=true`;
  const res = await args.fetchImpl(`${CF_API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${args.accessToken}`,
      accept: "application/json",
    },
  });
  await unwrap<unknown>(res, "DELETE", path);
}
