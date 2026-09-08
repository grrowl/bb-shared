/** The relay is compiled at release time and embedded in the plugin artifact. */
import { WORKER_SOURCE } from "./worker-source.generated";
export interface BundleOptions {
  log?: { info?(message: string): void; warn(message: string): void };
}
export async function bundleWorker(_opts: BundleOptions = {}): Promise<string> {
  return WORKER_SOURCE;
}
