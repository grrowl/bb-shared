/** Worker transport bindings. No BB authority or invitation policy is deployed. */
export interface Env {
  TUNNEL_DO: DurableObjectNamespace;
  TUNNEL_SECRET: string;
}
