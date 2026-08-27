/**
 * Terminal stage: hand the prepared request to the tunnel router.
 *
 * The router presents a single `.dispatch(request)` entry point that speaks
 * to the DO stub over its DO fetch; internally the DO routes to a WS upgrade
 * or an HTTP proxy based on the `upgrade` header, so the pipeline stays flat.
 *
 * Later tickets that wrap the response (09 filters, 12 chrome shim) run as
 * additional stages AFTER this one — this stage always produces a `respond`
 * result, and the pipeline runner returns that response immediately. To
 * inject a post-processing wrap, insert a stage BEFORE dispatch that
 * captures the tail of the pipeline and mutates the response. Alternatively,
 * we refactor `runPipeline` to a onion-style call chain when 09 lands. For
 * now, the terminal short-circuit keeps the flow obvious.
 */

import { respond, type Stage } from "../pipeline.js";
import type { TunnelRouter } from "../tunnel/interface.js";

export function dispatchStage(router: TunnelRouter): Stage {
  return {
    name: "dispatch",
    async run(ctx) {
      const response = await router.dispatch(ctx.request);
      return respond(response);
    },
  };
}
