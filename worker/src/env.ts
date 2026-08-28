/**
 * Worker runtime bindings.
 *
 * `TUNNEL_SECRET` gates `/__tunnel` dials from the owner's local half. It is
 * provisioned by the plugin at deploy time (issue 07) as a Cloudflare secret,
 * and the same value is planted in the local bb-shared plugin's KV so the
 * `SharedTunnel` client (issue 14) can present it as a bearer.
 *
 * Format of the secret is TBD by 07 — this scaffold treats it as an opaque
 * string, compared byte-for-byte with a constant-time function.
 *
 * `AUTHZ_TOKEN` is the per-plugin bearer for the plugin's `/authz` endpoint
 * (issue 06). The authz stage (issue 10) presents it as `Authorization: Bearer`
 * on every scope query; provisioned alongside `TUNNEL_SECRET` at deploy time
 * (issue 07, `bb plugin token bb-shared`). Never sent to guests, never logged.
 */
export interface Env {
  TUNNEL_DO: DurableObjectNamespace;
  TUNNEL_SECRET: string;
  AUTHZ_TOKEN: string;
}
