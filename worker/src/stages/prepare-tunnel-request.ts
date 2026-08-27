/**
 * Stage 3: build the Request that will be dispatched through the tunnel.
 *
 * Currently just calls `prepareOriginForTunnel` (see origin.ts for the full
 * argument). Isolated as a stage so later tickets can extend it:
 *
 *   - 10 (mutation gate): short-circuit here for disallowed method/path combos
 *   - Additional header hygiene (strip `x-forwarded-*` etc.) if it becomes
 *     necessary
 */

import { prepareOriginForTunnel } from "../origin.js";
import { cont, type Stage } from "../pipeline.js";

export const prepareTunnelRequestStage: Stage = {
  name: "prepare-tunnel-request",
  run(ctx) {
    const request = prepareOriginForTunnel(ctx.request, ctx.workerPublicOrigin);
    return cont({ ...ctx, request });
  },
};
